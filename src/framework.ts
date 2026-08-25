import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import type { Membrane, ContentBlock, NormalizedRequest, YieldingStream, ToolResult as MembraneToolResult, ToolResultContentBlock } from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import { ContextManager, PassthroughStrategy } from '@animalabs/context-manager';
import type {
  MessageId,
  MessageMetadata,
  MessageQuery,
  MessageQueryResult,
  StoredMessage,
  TokenBudget,
} from '@animalabs/context-manager';
import type {
  FrameworkConfig,
  InferencePolicy,
  ErrorPolicy,
  ErrorAction,
  FrameworkState,
  TraceEvent,
  TraceEventListener,
  InferenceLogEntry,
  InferenceLogQuery,
  InferenceLogQueryResult,
  InferenceLogEntryWithId,
  InferenceLogSummary,
  ProcessLogEntry,
  ProcessLogQuery,
  ProcessLogQueryResult,
  ProcessLogEntryWithId,
  ProcessLogSummary,
  ProcessEvent,
  EventResponse,
  ModuleProcessResponse,
  AgentSettleResult,
  ToolCall,
  ToolCallEvent,
  ToolResult,
  CompletedToolCall,
  AgentConfig,
  InferenceRequest,
  AgentState,
  Module,
  SpeechContext,
  ContextMaintenanceRun,
  ContextMaintenanceAgentRun,
  ContextMaintenanceSnapshot,
  AgentRuntimeSettingsPatch,
  AgentRuntimeSettingsOverrides,
  AgentRuntimeSettingsSnapshot,
  AgentSettingsExtension,
  SameRoundThinkTextPolicy,
} from './types/index.js';
import { ProcessQueueImpl } from './queue.js';
import { REFUSAL_REACTIONS, REFUSAL_REACTION_FALLBACK } from './refusal-reactions.js';
import { Agent } from './agent.js';
import { ModuleRegistry, isStateExistsError } from './module-registry.js';
import { McplServerRegistry } from './mcpl/server-registry.js';
import { FeatureSetManager } from './mcpl/feature-set-manager.js';
import { computeGrant, CapabilityGrant, expandAdvertisementShorthand } from './mcpl/capability-grant.js';
import { maskNegotiatedCapabilities } from './mcpl/capability-mask.js';
import { HookOrchestrator } from './mcpl/hook-orchestrator.js';
import { PushHandler, type McplPushEvent } from './mcpl/push-handler.js';
import { parseProsePrefix, parseHybridProsePrefix } from './mcpl/prose-grammar.js';
import { ProseStreamRouter } from './mcpl/prose-stream-router.js';
import { InferenceRouter } from './mcpl/inference-router.js';
import { ChannelRegistry, type ChannelToolOrigin } from './mcpl/channel-registry.js';
import { ConversationRouter } from './mcpl/conversation-router.js';
import { safeSlice } from './safe-slice.js';
import type { WorkspaceModule } from './modules/workspace/index.js';
import {
  toolResultDataToHistoryString,
  truncateForHistory,
  DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS,
} from './tool-result-history.js';
import { randomUUID } from 'node:crypto';
import { PyRunner, buildInjectedTools } from './code-execution/py-runner.js';
import {
  buildCodeExecutionToolDefinition,
  CODE_EXECUTION_TOOL_NAME,
} from './code-execution/tool-definition.js';
import { splitProseSegments } from './prose-segments.js';

/** Detect a supported image media type from magic bytes (the model API
 *  rejects mislabeled media types, so trust bytes over extensions).
 *  Returns undefined for non-image content. */
function sniffImageMediaType(data: Buffer): string | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * Tools whose presence suppresses auto-routing of the surrounding prose,
 * for two distinct reasons:
 *   - `skip_reply` — the agent EXPLICITLY chose not to reply (the deliberate
 *     "stay silent" signal).
 *   - explicit delivery tools (channel_publish / *send_message /
 *     *reply_message / *send_dm) — already sent the message, so routing the
 *     prose again would double-post.
 * `think` is deliberately NOT here: it is silent *reasoning*, and same-round
 * prose beside it is governed separately by same_round_think_text_policy.
 *
 * Scope: an explicit delivery suppresses prose from that round onward until
 * another external message is injected. The suppression prevents a
 * `send_message` followed by "sent it" from double-posting, but a new message
 * starts a new conversational round and must be answerable with plain prose.
 * `skip_reply` ends the turn at the tool-result boundary.
 */
const SILENCING_TOOLS = new Set([
  'skip_reply', 'channel_publish', 'send_message', 'reply_message', 'send_dm',
]);

/** World-surface publication names that outrank hybrid prose envelopes. */
const HYBRID_PUBLICATION_TOOLS = new Set(['say', 'whisper']);

/**
 * True when an injected message is real conversational input — something the
 * agent might actually be replying to — rather than ambient machinery.
 * System markers (`system: true` — send-failed notices, routing notices) and
 * reactions (`chat:reaction` tag, MCPL RFC-001) don't count: they must not
 * clear explicit-send suppression, and they never influence routing.
 */
const isConversationalInjection = (metadata?: MessageMetadata): boolean => {
  if (!metadata) return true;
  const m = metadata as Record<string, unknown>;
  if (m.system === true) return false;
  if (Array.isArray(m.tags) && m.tags.includes('chat:reaction')) return false;
  return true;
};

/**
 * Rough token estimate for the blocks a continuation round is about to
 * append to the live wire (issue #92 physical-window projection): the
 * spilled tool-result strings at chars/4, a flat per-image cost for native
 * image blocks the wire path preserves (provider vision tokens are
 * resolution-dependent; 1600 ≈ a max-size Anthropic tile), mid-turn injected
 * text at chars/4, and a small per-block envelope allowance. Deliberately a
 * ceiling-ish heuristic — the cost of overestimating is one early recompile;
 * the cost of underestimating is the 400 this projection exists to prevent.
 */
function estimateAppendedRoundTokens(
  toolResults: CompletedToolCall[],
  spilled: Map<string, { text: string; filePath: string | null }>,
  injections: Array<{ content: ContentBlock[] }>,
): number {
  let chars = 0;
  let images = 0;
  for (const tc of toolResults) {
    chars += spilled.get(tc.id)?.text.length ?? 0;
    if (Array.isArray(tc.result.data)) {
      for (const raw of tc.result.data) {
        const b = raw as { type?: unknown };
        if (b && typeof b === 'object' && b.type === 'image') images += 1;
      }
    }
  }
  for (const inj of injections) {
    for (const block of inj.content) {
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        chars += (block as { text: string }).text.length;
      }
    }
  }
  const blockCount = toolResults.length + injections.length;
  return Math.ceil(chars / 4) + images * 1600 + blockCount * 20;
}

/**
 * Explicit delivery tools whose successful use into a closed channel OPENS
 * it (send implies engagement — see openIfClosedForSend). Bare tool names,
 * matched after stripping the MCPL server prefix.
 */
const SEND_ENGAGEMENT_TOOLS = new Set([
  'send_message', 'reply_message', 'send_dm', 'send_file', 'send_files',
]);

/**
 * Best-effort extraction of the delivered channel id from an MCPL send-tool
 * result (the discord-mcpl send tools return JSON like
 * `{"messageId":"…","channelId":"…"}` as a text block). Returns undefined on
 * any shape mismatch — the caller falls back to the tool's input args.
 */
function extractChannelIdFromToolResult(
  content: Array<{ type: string; text?: string }> | undefined,
): string | undefined {
  const text = content?.find((c) => c.type === 'text' && c.text)?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { channelId?: unknown };
    return typeof parsed.channelId === 'string' && parsed.channelId.length > 0
      ? parsed.channelId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when an incoming channel message explicitly addressed the agent.
 * Primary signal is the MCPL RFC-001 `chat:addressed` tag (mention / reply /
 * DM, as classified by the server); the metadata booleans are the fallback
 * for servers that predate tags. Addressed messages outrank ambient chatter
 * when picking a turn's frozen speech locus.
 */
const isAddressedMessage = (
  tags?: string[],
  _metadata?: Record<string, unknown>,
): boolean => Array.isArray(tags) && tags.includes('chat:addressed');

// parseProsePrefix moved to ./mcpl/prose-grammar.ts — ONE grammar shared with
// the outgoing-stream router (Spec 14.3), so streamed chunks and delivered
// envelopes can never disagree on what is a prefix.

/** One-time primer appended when an agent's proseRouting mode changes. */
function proseModePrimer(mode: 'explicit' | 'hybrid' | 'locus' | 'disabled'): string {
  if (mode === 'locus') {
    return '[prose-routing] Mode change: your plain text auto-routes to the ' +
      'conversational locus again. `>>` destination prefixes are no longer needed.';
  }
  if (mode === 'hybrid') {
    return '[prose-routing] Hybrid routing enabled: unprefixed text still lands in the ' +
      'current conversational locus. A leading `>>>destination` envelope instead routes ' +
      'that prose to one uniquely resolved authorized Discord or Eidoverse channel. The ' +
      'envelope remains in your memory but recipients see only its body; delivery or failure ' +
      'is reported back to you.';
  }
  // Deliberately terse: a short event-style notice is classifier-safe from
  // the user role (ablation D, 2026-07-24), while the full grammar as a user
  // message drew a deterministic reasoning_extraction refusal (ablation A/B).
  // The grammar is TAUGHT BY BOUNCE: the first undelivered text produces a
  // notice with the exact resend syntax, and the full reference is available
  // on demand via the prose_help tool (a tool RESULT is model-requested
  // content — the safest role there is). Nothing is injected into the system
  // prompt: those bytes belong to the recipe, and the deepest KV prefix must
  // not vary with framework code.
  return (
    '[prose-routing] Output mode changed: plain text is delivered only with a ' +
    'destination prefix line, e.g. ">>#channel-name your text". ' +
    'The prose_help tool shows the full syntax.'
  );
}

/** Full `>>` routing reference, served as the prose_help TOOL RESULT (never
 *  injected ambiently — see proseModePrimer note). */
const PROSE_ROUTING_HELP =
  'Plain-text output routing (explicit mode):\n' +
  '  >>#channel-name …    or    >>@person …  (DM)    or    >>service:guild:id …\n' +
  '  One message may hold several sections: each line starting with ">>" begins\n' +
  '  a new envelope, routed to its own destination independently.\n' +
  '  The first destination in a turn applies to the rest of that turn.\n' +
  '  Append " !" after the destination (e.g. ">>#ops !") to start your next turn\n' +
  '  immediately when this one ends, instead of pausing until the next event.\n' +
  '  >>skip_reply — text stays in your context only, like the skip_reply tool.\n' +
  'Text without a destination is not delivered: it is retained, and a notice will\n' +
  'prompt you to resend — reply e.g. ">>#channel {{unsent}}" to deliver the retained\n' +
  'text unchanged. Send tools (send_message, send_dm, …) are unaffected.';

const PROSE_HELP_TOOL: import('./types/index.js').ToolDefinition = {
  name: 'prose_help',
  description: 'Show the plain-text output routing syntax (destination prefixes, resend token, skip).',
  inputSchema: { type: 'object' as const, properties: {} },
};
/** Strip the `server--` MCPL prefix from a tool name. */
const bareToolName = (n: string): string => n.split('--').pop()!;

/** The single slot behind which every rarely-used capability lives. Only
 *  advertised when at least one module contributes utilities — with none
 *  registered the surface is byte-identical to before this existed. */
const UTILS_TOOL: import('./types/index.js').ToolDefinition = {
  name: 'utils',
  description:
    'Rarely-used utilities, behind one slot instead of each costing a tool. ' +
    '"list" names them all with one-liners; "describe" returns one utility\'s full ' +
    'input schema; "run" invokes it (args are validated against that schema — a ' +
    'miss bounces back with the schema and the specific error).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'describe', 'run'], description: 'What to do.' },
      name: { type: 'string', description: 'Utility name from list (required for describe/run).' },
      args: { type: 'object', description: "Arguments for run, per the utility's schema." },
    },
    required: ['action'],
  },
};

/** First sentence (or line) of a description — what `utils list` shows. */
const utilityOneLiner = (description: string): string => {
  const line = description.split('\n')[0]!;
  const dot = line.indexOf('. ');
  return (dot >= 0 ? line.slice(0, dot + 1) : line).slice(0, 160);
};

/** Shallow validation of run args against a utility's declared inputSchema:
 *  required keys, primitive types, enums. Deliberately not a full JSON-Schema
 *  engine — handlers still hand-validate (they always did); this layer exists
 *  so an arg-shape miss teaches by bounce instead of failing deep in a handler
 *  with a less instructive message. Returns an error string or null. */
function validateUtilityArgs(
  input: unknown,
  schema: import('./types/index.js').ToolDefinition['inputSchema'],
): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'args must be an object';
  }
  const obj = input as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (!(req in obj) || obj[req] === undefined) return `missing required "${req}"`;
  }
  for (const [key, value] of Object.entries(obj)) {
    const param = schema.properties?.[key];
    if (!param || value === undefined) continue; // unknown keys: handler's business
    if (param.enum && !(param.enum as unknown[]).includes(value)) {
      return `"${key}" must be one of ${JSON.stringify(param.enum)}`;
    }
    if (param.type) {
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      const expected = param.type === 'integer' ? 'number' : param.type;
      if (actual !== expected) return `"${key}" must be ${param.type}, got ${actual}`;
    }
  }
  return null;
}
import { CheckpointManager } from './mcpl/checkpoint-manager.js';
import { isToolAllowed } from './mcpl/tool-policy.js';
import { EventGate, formatShadowWarning } from './gate/event-gate.js';
import { UsageTracker, type PersistedUsageState } from './usage/usage-tracker.js';
import type { SessionUsageSnapshot, UsageUpdatedEvent } from './usage/types.js';
import type { McplServerConnection } from './mcpl/server-connection.js';
import type {
  McplServerConfig,
  McplHostCapabilities,
  FeatureSetsChangedParams,
  BeforeInferenceParams,
  PushEventParams,
  McplInferenceRequestParams,
  ChannelsRegisterParams,
  ChannelsChangedParams,
  ChannelsIncomingParams,
} from './mcpl/types.js';
import type { ContextInjection } from '@animalabs/context-manager';
import { formatZonedDateTime, resolveTimeZone } from './timezone.js';
import {
  DEFAULT_DISCORD_AWARENESS_EMOJI,
  DiscordAwarenessOutbox,
  defaultDiscordAwarenessOutboxPath,
  extractDiscordAwarenessRefs,
} from './recovery/discord-awareness-outbox.js';

const FRAMEWORK_STATE_ID = 'framework/state';
const CONVERSATION_ROUTER_STATE_ID = 'framework/conversation-router';
const INFERENCE_LOG_ID = 'framework/inference-log';
const PROCESS_LOG_ID = 'framework/process-log';
const TURN_CHECKPOINTS_ID = 'framework/turn-checkpoints'; // legacy single-map layout, read-only fallback
const TURN_CHECKPOINTS_TREE_ID = 'framework/turn-checkpoints/tree';

/** Maximum number of turn checkpoints to keep per agent. */
const MAX_TURN_CHECKPOINTS = 20;
const DEFAULT_DISCORD_AWARENESS_DEADLINE_MS = 10_000;
const MIN_DISCORD_AWARENESS_DEADLINE_MS = 50;
const MAX_DISCORD_AWARENESS_DEADLINE_MS = 60_000;

interface TurnCheckpoint {
  agentName: string;
  turnIndex: number;
  sequenceBefore: number;
  branchName: string;
  timestamp: number;
}

type DiscordAwarenessDrainOutcome =
  | { status: 'delivered'; delivered: number; failed: number }
  | { status: 'unavailable'; accounted: number };

interface DiscordAwarenessBarrier {
  generation: number;
  requiresBarrier: boolean;
  promise: Promise<DiscordAwarenessDrainOutcome>;
}

function normalizeDiscordAwarenessDeadline(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DISCORD_AWARENESS_DEADLINE_MS;
  }
  return Math.max(
    MIN_DISCORD_AWARENESS_DEADLINE_MS,
    Math.min(MAX_DISCORD_AWARENESS_DEADLINE_MS, Math.floor(value)),
  );
}

class DiscordAwarenessAccountingError extends Error {
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Discord awareness accounting failed during ${operation}: ${detail}`, { cause });
    this.name = 'DiscordAwarenessAccountingError';
  }
}

interface RedoEntry {
  branchName: string;
  checkpoint: TurnCheckpoint;
}

interface InferenceToolSnapshot {
  sameRoundThinkTextPolicy: SameRoundThinkTextPolicy;
}

/**
 * Default inference policy - infer if any request exists for the agent.
 */
class DefaultInferencePolicy implements InferencePolicy {
  shouldInfer(
    agentName: string,
    requests: InferenceRequest[],
    _state: FrameworkState
  ): boolean {
    return requests.some((r) => r.agentName === agentName);
  }
}

function isPermanentDiscordReactionFailure(message: string): boolean {
  return /unknown message|unknown channel|missing access|missing permissions|missing permission|cannot access|channel .* not found|message .* not found/i
    .test(message);
}

/**
 * Default error policy - retry with exponential backoff.
 *
 * Respects MembraneError.retryable: non-retryable errors (400 invalid_request,
 * 401 auth, context_length, safety) are terminal on attempt 0. Retrying them
 * burns API quota without any chance of success — the payload doesn't change
 * between attempts. Production traces showed clerk + reviewer wasting 4
 * inferences on each 400 due to blind retries.
 *
 * For retryable errors, honors retryAfterMs when present (rate limits),
 * otherwise falls back to exponential backoff capped at maxRetries.
 */
class DefaultErrorPolicy implements ErrorPolicy {
  maxRetries = 3;

  onInferenceError(error: Error, _agentName: string, attempt: number): ErrorAction {
    if (error instanceof MembraneError && !error.retryable) {
      return { retry: false };
    }
    if (attempt < this.maxRetries) {
      const delayMs = error instanceof MembraneError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : Math.pow(2, attempt) * 1000;
      return { retry: true, delayMs };
    }
    return { retry: false };
  }
}

/** Default sync interval in milliseconds */
const DEFAULT_SYNC_INTERVAL_MS = 1000;
/** Poll pending context-strategy maintenance independently of user activity. */
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5000;
/** Bound one pass so a large backlog yields to inference and other agents. */
const MAINTENANCE_TICKS_PER_PASS = 8;

/** Local per-residence provider admission (AF #114 bounded first slice). */
interface LocalProviderGate {
  primaryDepth: number;
  primaryPending: boolean;
  auxiliaryInFlight: number;
  auxiliaryWaiters: Array<() => void>;
  idleWaiters: Array<() => void>;
  deferredAuxiliary: number;
}
interface ProviderAccelerationCooldown {
  startedAt: number;
  until: number;
  timer: ReturnType<typeof setTimeout>;
  heldRequests: InferenceRequest[];
  reason: string;
  failures: number;
}
interface ProviderAccelerationRecovery {
  startedAt: number;
  releasedAt?: number;
  failures: number;
  heldRequests: number;
  reason: string;
}
interface ProviderAccelerationReceipt {
  startedAt: number;
  releasedAt: number;
  completedAt: number;
  cooldownMs: number;
  waitedMs: number;
  failures: number;
  heldRequests: number;
  messageCount: number;
  toolCount: number;
  stopReason: string;
}
const PROVIDER_ACCELERATION_DEFAULT_COOLDOWN_MS = 65_000;
const PROVIDER_ACCELERATION_MAX_COOLDOWN_MS = 10 * 60_000;
const PROVIDER_ACCELERATION_JITTER_MS = 5_000;
function isOrganizationAccelerationRateLimit(error: Error): error is MembraneError {
  if (!(error instanceof MembraneError) || error.type !== 'rate_limit') return false;
  return (
    /organization(?:'s)?[^\n]{0,120}maximum(?:\s+usage)?\s+increase\s+rate/i.test(error.message) ||
    /organization(?:'s)?[^\n]{0,120}acceleration(?:\s+limit)?/i.test(error.message)
  );
}

/**
 * Extract fields the EventGate cares about from a ProcessEvent. The set of
 * event variants that carry `content`/`mount`/`paths`/`metadata` is open-ended
 * (modules can define CustomEvents), so we read by name rather than match the
 * discriminant. Centralizing this lets new gate-visible fields be added in one
 * place instead of retyping the narrowing at every call site.
 */
function extractGateFields(event: ProcessEvent): {
  content: string;
  metadata: Record<string, unknown>;
  mount?: string;
  paths?: string[];
} {
  const rec = event as unknown as Record<string, unknown>;
  const rawContent = rec.content;
  let content = '';
  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    // ContentBlock[] — concatenate text blocks so gate content filters match
    content = rawContent
      .filter((b): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        && typeof (b as { text?: unknown }).text === 'string'
      )
      .map(b => b.text)
      .join('\n');
  }
  const metadata = (rec.metadata && typeof rec.metadata === 'object')
    ? rec.metadata as Record<string, unknown>
    : {};
  const mount = typeof rec.mount === 'string' ? rec.mount : undefined;
  const paths = Array.isArray(rec.paths)
    ? rec.paths.filter((p): p is string => typeof p === 'string')
    : undefined;
  return { content, metadata, mount, paths };
}

/**
 * The main agent framework.
 */
/** Params for a `host/command` request from an MCPL surface server. */
interface HostCommandParams {
  command?: string;
  agentName?: string;
  turns?: number;
  /** Message-granular undo: branch the chronicle so the last N messages
   *  (regardless of participant) are no longer on the active branch.
   *  Mutually exclusive with `turns`. */
  messages?: number;
  /** For the `hide` command: Discord message id of the (first) message to
   *  remove. With `toMessageId`, removes the inclusive range between them. */
  fromMessageId?: string;
  /** For the `hide` command: Discord message id ending an inclusive range. */
  toMessageId?: string;
  /** For the `unstick` command: max rewind/retry attempts (default = the
   *  agent's refusalHandling.maxRewinds, else 3). */
  maxRewinds?: number;
  /** For the `unstick` command: raw channel id to post the outcome report to. */
  channelId?: string;
  requesterId?: string;
  requesterName?: string;
}

/** Descriptor of a single refusal-driven rewind (see rewindTriggeringTurn). */
interface RewindRecord {
  /** tool = machine tool exchange; human = an ingested message; other = else. */
  kind: 'tool' | 'human' | 'other';
  /** Content-free, safe-to-replay description of what was withheld. */
  descriptor: string;
  /** All message ids removed in this shed (a tool exchange removes 2+). */
  removedIds: MessageId[];
  /** Discord (channelId, messageId) of the removed message, if it had one. */
  discordRef?: { channelId: string; messageId: string };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** Per-run state for a framework-driven ephemeral agent: the settle signal
 *  the caller awaits plus the liveness/progress bookkeeping the watchdogs and
 *  the stream driver share. One map entry per run — created and torn down in
 *  runEphemeralToCompletion — so the pieces cannot desync. */
/** One model-authored background (daemon) script — see runCodeExecution. */
interface BackgroundScriptRecord {
  id: string;
  agentName: string;
  runner: PyRunner;
  /** The agent-authored source (line numbers in wake envelopes index into it). */
  code: string;
  startedAt: number;
  wakes: number;
  lastWakeAt: number | null;
  /** Mount-prefixed workspace path of the journal, null when no workspace. */
  logPath: string | null;
  status: 'running' | 'finished' | 'died' | 'cancelled';
  /** Set when cancel/dispose already settled this script (suppresses wakes). */
  cancelled: boolean;
}

interface EphemeralRun {
  settle: Deferred<AgentSettleResult>;
  inferenceStarted: boolean;
  lastActivity: number;
  toolCallsCount: number;
}

/** Cap an API error message for inline use in a rewind marker: keep enough to
 *  identify the failure class without pasting a wall of provider JSON into the
 *  agent's context. */
function truncateReason(reason: string, max = 160): string {
  return reason.length <= max ? reason : reason.slice(0, max) + '…';
}

export class AgentFramework {
  private store: JsStore;
  private ownsStore: boolean;
  private membrane: Membrane;
  private queue: ProcessQueueImpl;
  private agents: Map<string, Agent> = new Map();
  private moduleRegistry: ModuleRegistry;
  private inferencePolicy: InferencePolicy;
  private errorPolicy: ErrorPolicy;
  private pendingRequests: InferenceRequest[] = [];
  /**
   * Per-agent channel that triggered the agent's CURRENT inference turn, if any
   * (item-3 redux). Read by the ChannelRegistry's `activeChannelResolver` to
   * route a single-trunk agent's plain-text speech back to the channel it is
   * answering, instead of the process-global most-recent-inbound locus that a
   * concurrent message elsewhere can hijack. Set at turn start (or cleared for a
   * heartbeat / no-trigger turn) in startAgentStream; overwritten by the next
   * turn. Never read between turns (a given agent runs one turn at a time).
   */
  private activeTriggerChannels: Map<string, string> = new Map();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private traceListeners: TraceEventListener[] = [];
  private syncIntervalMs: number;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceIntervalMs: number;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenancePass: Promise<void> | null = null;
  private maintenanceRunId = 0;
  private currentMaintenanceRun: ContextMaintenanceRun | null = null;
  private maintenanceHistory: ContextMaintenanceRun[] = [];
  private providerGates: Map<string, LocalProviderGate> = new Map();
  private providerAccelerationCooldowns: Map<string, ProviderAccelerationCooldown> = new Map();
  private providerAccelerationRecoveries: Map<string, ProviderAccelerationRecovery> = new Map();
  private providerAccelerationLastRecovery: Map<string, ProviderAccelerationReceipt> = new Map();
  private providerAccelerationDefaultCooldownMs = PROVIDER_ACCELERATION_DEFAULT_COOLDOWN_MS;
  private providerAccelerationJitterMs = PROVIDER_ACCELERATION_JITTER_MS;
  private providerAdmissionClosed = false;
  /** Last time we reported stale (busy-requeued) inference requests, per agent. */
  private staleWarnAt = new Map<string, number>();
  /** Per-agent last inference activity (epoch ms), for /healthz + doctor tooling. */
  private lastInferenceAt = new Map<string, { startedAt?: number; endedAt?: number; failedAt?: number; lastError?: string }>();
  private processLoggingPersist: boolean;
  private processLoggingBroadcast: boolean;
  private activeStreams: Map<string, Promise<void>> = new Map();

  /** Per-agent output locus FROZEN for the CURRENT logical turn. Resolved
   *  eagerly in startAgentStream (home → addressed trigger → global default)
   *  and never moved until the next turn: mid-turn injected messages — ambient
   *  chatter, reactions, system markers — must not hijack where the agent's
   *  plain prose lands (2026-07-21 Cairn lounge misroute). Lives here — not in
   *  driveStream locals — so the pin survives a context-budget stream restart,
   *  which continues the same logical turn in a fresh driveStream. Cleared or
   *  re-set at the start of every non-restart turn. Since 2026-07-31 the pin
   *  is no longer fully frozen: an ADDRESSED conversational injection — or a
   *  conversational follow-up in a channel the agent itself explicitly sent
   *  into this turn (turnEngagedChannels) — re-pins it at the boundary (see
   *  the addressed re-pin block in the tool-result handler). Ambient chatter
   *  elsewhere, reactions, and system markers still cannot move it. */
  private turnLocusPins: Map<string, string> = new Map();
  /** Channels the agent EXPLICITLY sent into during the CURRENT turn
   *  (SEND_ENGAGEMENT_TOOLS, successful calls), per agent. Second re-pin
   *  signal: a conversational reply in a channel the agent just engaged is
   *  addressed by context even without a mention (2026-07-31 n=7: q's
   *  #portables follow-up — no @mention — was answered in trailing prose
   *  that followed the stale pin into repligate's DM). No author-kind
   *  filter: agent-residents are full participants, and the bot flag
   *  tracks nothing that matters (antra). Reactions/system markers are
   *  excluded by isConversationalInjection; the engaged-this-turn scope
   *  keeps unrelated channels from moving the pin. Cleared at every fresh
   *  turn's start; budget restarts keep it. */
  private turnEngagedChannels: Map<string, Set<string>> = new Map();
  /** Channels this turn's PLAIN PROSE was actually delivered to, in delivery
   *  order (deduped at render). Feeds the `[delivered]` receipt appended at
   *  logical turn end: explicit sends receipt themselves via their
   *  tool_result, but auto-routed prose previously vanished into the router
   *  with no in-window record — the agent could never see where its own
   *  words landed (2026-07-31 misroute series; antra: minimal receipts).
   *  Cleared at every fresh turn's start; budget restarts keep it (same
   *  logical turn, receipt covers the whole turn). */
  private turnProseDeliveries: Map<string, string[]> = new Map();
  /** Count of plain-prose segments SUPPRESSED this turn by sticky
   *  explicit-send silencing. The suppression rule itself is untouched
   *  (antra, 2026-07-31: visibility is enough) — but it must never be a
   *  silent black hole: Mythos multiplexed two threads in one round (prose
   *  for the lane + explicit send for another channel, textbook per the
   *  routing doc), the silencing ate the prose reply, and his own record
   *  ("scene delivered to #mythos via plain speech — routing confirmed")
   *  believed it delivered. The receipt now reports suppression, so the
   *  author sees the segment's fate one turn later. Cleared each fresh
   *  turn; budget restarts keep it. */
  private turnProseSuppressed: Map<string, number> = new Map();
  /** A tool boundary injected fresh CONVERSATIONAL input (a real message —
   *  not a reaction or a system marker) into the live stream. Tells
   *  driveStream to clear sticky explicit-send suppression before handling
   *  the next model round. Never affects routing: the turn locus is frozen. */
  private midTurnInputSignals: Set<string> = new Set();
  /** Last outbound locus announced to each agent as a durable `[routing]`
   *  window message. Announce-on-change only: steady state emits nothing
   *  (KV-safe, no per-turn chatter). In-memory — after a process restart the
   *  first turn's locus is announced once to re-establish the baseline. */
  private lastAnnouncedLocus: Map<string, string | null> = new Map();

  // ---- Explicit prose routing (docs/explicit-prose-routing.md) ----------
  /** Latest bounced (undelivered) prose per agent — the `{{unsent}}` source. */
  private proseClipboards: Map<string, string> = new Map();
  /** Sticky per-TURN delivery target set by the turn's first `>>` prefix.
   *  Cleared at every non-restart turn start; survives context restarts. */
  private proseTargetPins: Map<string, string> = new Map();
  /** Hybrid router is fail-closed after a malformed/unresolved envelope until a new valid target. */
  private proseHybridSuppressed: Set<string> = new Set();
  /** Agents whose current turn requested `!` continuation — re-woken when the
   *  turn completes instead of pausing until the next external event. */
  private proseContinuations: Set<string> = new Set();
  /** Consecutive bounce-wakes per agent; capped so an agent that keeps
   *  emitting unprefixed prose can't wake-loop (notices still append). */
  private proseBounceStreaks: Map<string, number> = new Map();
  private pendingAssistantBlocks: Map<string, ContentBlock[]> = new Map();
  /** Streams the FRAMEWORK cancelled for non-terminal reasons, keyed
   *  `${agentName}:${streamId}`: an endTurn tool result or a context-budget
   *  restart. The membrane still delivers an `aborted` event for these, and
   *  without the marker the abort handler would treat it as a terminal
   *  failure — settling ephemerals with a rejection and emitting a spurious
   *  `inference:exhausted` (which also pollutes the failure streak). Kept
   *  separate from ephemeralRuns deliberately: endTurn/budget cancels happen
   *  for resident agents too, and the key is per-stream, not per-agent. */
  private frameworkCancelledStreams: Map<string, 'turn_ended' | 'budget_restart'> = new Map();
  /** Active runEphemeralToCompletion runs, keyed by agent name. */
  private ephemeralRuns: Map<string, EphemeralRun> = new Map();
  /** Per-agent count of consecutive exhausted inferences (reset on any success).
   *  Drives hard-down escalation — see noteInferenceExhausted. */
  private consecutiveInferenceFailures: Map<string, number> = new Map();
  /** N consecutive failed inferences ⇒ the agent is treated as hard-down and
   *  escalated loudly to stderr. */
  private readonly inferenceFailureEscalationThreshold = 3;
  /** Per-(agent,kind) timestamp of the last ops webhook post. Throttles
   *  opsAlert() so a persistent failure re-posts once per cooldown window
   *  instead of on every occurrence. */
  private opsAlertLastSent: Map<string, number> = new Map();
  /** Cooldown between webhook posts for the same (agent, kind). */
  private readonly opsAlertCooldownMs = 15 * 60_000;
  /** Per-agent refusal bookkeeping for observability — exposed via
   *  healthSnapshot() and mirrored to failures.log / ops alerts. */
  private refusalStats: Map<string, { total: number; byCategory: Record<string, number>; lastAt: number; lastCategory: string }> = new Map();
  /** Per-agent count of consecutive refusals (reset on any non-refusal
   *  completion). Distinct from refusalRewinds, which budgets the auto-rewind
   *  loop — this one drives ops alerting. */
  private refusalStreak: Map<string, number> = new Map();
  /** Per-agent count of consecutive refusal-driven rewinds in the current turn
   *  chain (reset when a turn completes without a refusal). Bounds the auto
   *  rewind loop — see refusalHandling + rewindTriggeringTurn. */
  private refusalRewinds: Map<string, number> = new Map();
  /** Per-agent count of poison-history rewinds performed by the hard-down
   *  breaker (noteInferenceExhausted). Reset on any successful inference.
   *  Bounds the automatic quarantine loop the same way refusalRewinds bounds
   *  the refusal loop, so the breaker can never shed the whole history. */
  private exhaustionRewinds: Map<string, number> = new Map();
  /** Agents with an OverBudget drain kick currently in flight. The breaker in
   *  noteInferenceExhausted fires on EVERY matching failure and the scenario it
   *  exists for is "every activation fails, repeatedly" — without this guard,
   *  overlapping kicks race the strategy's own pendingCompression gate and the
   *  tick counts in the success log stop meaning anything. One kick per agent
   *  at a time; cleared when the kick settles (success or failure). */
  private overBudgetDrainInFlight: Set<string> = new Set();
  /** Per-agent current rewind episode: the single consolidated marker's id and
   *  how many turns have been shed so far. One marker per episode, updated in
   *  place (see updateRewindMarker); cleared when the episode ends. */
  private rewindEpisode: Map<string, { markerId: MessageId; count: number; category: string }> = new Map();
  /** Active `/unstick` sessions: an admin-forced rewind-until-clean loop that
   *  runs even when the agent's autoRewind toggle is off. Tracks the remaining
   *  budget, what was shed (for the report), and where to post the outcome. */
  private forcedRewind: Map<string, {
    remaining: number;
    removed: RewindRecord[];
    serverId: string;
    channelId: string;
  }> = new Map();
  /** Name of the primary (non-ephemeral) agent for routing framework messages. */
  private primaryAgentName: string | null = null;

  // Messages deferred while an agent is waiting_for_tools (to preserve
  // tool_use → tool_result adjacency required by the Anthropic API).
  private deferredMessages: Array<{ participant: string; content: ContentBlock[]; metadata?: MessageMetadata }> = [];

  // Turn-alive markers (2026-07-31 Mythos phantom-skip incident): agentName →
  // token of the turn currently in progress. Set at startAgentStream ENTRY —
  // before hooks, compile, and stream setup, all of which await — and cleared
  // token-matched when that turn's teardown finishes (driveStream finally /
  // terminal failure path), so a successor turn's marker survives a
  // predecessor's late finally. A turn is alive from dequeue to settled
  // teardown: strictly longer than `activeStreams` membership, which begins
  // only after the stream exists. Guarding addMessage on stream-liveness
  // alone left the compile window open — a deferred message flushed by the
  // previous turn's finally landed in the window MID-COMPILE of the turn its
  // own wake had started: positioned before the new turn's blocks yet absent
  // from its wire request. The agent then "skipped" a message it never saw
  // (falsified history — it later confabulated an apology for the skip), and
  // every subsequent compile diverged from the live prefix at that message
  // (KV bust). Invariant: nothing enters the window between a turn's dequeue
  // and its settle except that turn's own blocks.
  private activeTurnTokens: Map<string, number> = new Map();
  private nextTurnToken = 1;

  // Undo/redo state
  private turnCounters: Map<string, number> = new Map(); // agentName → next turnIndex
  private redoStacks: Map<string, RedoEntry[]> = new Map(); // agentName → redo entries

  /** Liveness watchdog (fail hard on a wedged main thread). Null unless enabled. */
  private livenessWatchdog: import('./runtime/liveness-watchdog.js').LivenessWatchdog | null = null;

  // MCPL subsystems (null when no mcplServers configured)
  private mcplServerRegistry: McplServerRegistry | null = null;
  private featureSetManager: FeatureSetManager | null = null;
  private hookOrchestrator: HookOrchestrator | null = null;
  private pushHandler: PushHandler | null = null;
  private inferenceRouter: InferenceRouter | null = null;
  private channelRegistry: ChannelRegistry | null = null;
  private checkpointManager: CheckpointManager | null = null;
  /** Per-channel conversation routing (null unless config.conversations set). */
  private conversationRouter: ConversationRouter | null = null;
  /** Agent configs by name — fork agents are built from the template's config. */
  private agentConfigs: Map<string, AgentConfig> = new Map();
  /**
   * Fork agent → its home channel. Permanent (unlike router bindings, which
   * expire): publish/injection scoping must survive unbinding so the closure
   * turn still lands in the right channel.
   */
  private conversationAgentHomes: Map<string, string> = new Map();
  /** Last idle-TTL sweep timestamp. */
  private lastConversationSweep = 0;

  /** Forks whose TTL closure turn has been queued — disposed (removed from
   * agents/agentConfigs/conversationAgentHomes) when their stream ends. */
  private closingConversationAgents: Set<string> = new Set();
  // Client-side programmatic tool calling (`code_execution`). Null unless
  // config.codeExecution.enabled. One PyRunner per agent (interpreter state
  // is per-agent, like a per-agent container); waiters resolve script-inner
  // tool calls dispatched through the normal dispatchToolCall path.
  private codeExecutionConfig: import('./types/index.js').CodeExecutionConfig | null = null;
  private codeExecutionRunners: Map<string, PyRunner> = new Map();
  private scriptToolWaiters: Map<string, (result: ToolResult) => void> = new Map();
  /** Agents whose running script hit an endTurn-carrying inner result —
   *  deferred and applied to the final code_execution result instead of
   *  cancelling the stream mid-script (which would wedge the turn). */
  private scriptDeferredEndTurn: Set<string> = new Set();
  /** Background (daemon) scripts: model-authored watchers that outlive their
   *  spawning turn. Each gets a DEDICATED PyRunner; wake_agent() injects a
   *  provenance envelope + payload and requests inference. Keyed by script id. */
  private backgroundScripts: Map<string, BackgroundScriptRecord> = new Map();
  private backgroundScriptCounter = 0;
  /** Resident-set per-agent tool-result inline cap (chars), via
   *  agent_settings `tool_result_inline_max_chars`. DURABLE: persisted in
   *  framework state like the core runtime settings and restored at create
   *  (antra + Sol, 08-06); reset clears it back to the residence default. */
  private toolResultInlineMaxCharsOverride: Map<string, number> = new Map();
  /** Durable residence-configured inline cap from
   *  FrameworkConfig.toolResultInlineMaxChars; null → house default. */
  private toolResultInlineMaxCharsConfig: number | null = null;

  private mcplTools: import('./types/index.js').ToolDefinition[] = [];
  /** Namespaced tool name → stateful feature-set attribution from tools/list. */
  private mcplToolFeatureSets: Map<string, string> = new Map();
  private mcplToolRefreshInFlight = false;
  private mcplToolRefreshPending = false;
  /** Maps tool prefix → serverId for dispatch routing. */
  private mcplPrefixMap: Map<string, string> = new Map();
  /** Maps serverId → McplServerConfig for prefix lookup. */
  private mcplServerConfigs: Map<string, import('./mcpl/types.js').McplServerConfig> = new Map();
  /** Host capabilities advertised during the MCP handshake — stored so servers
   *  can be connected at runtime (connectMcplServer) after initialization. */
  private mcplHostCapabilities: McplHostCapabilities | null = null;
  /** Inference routing policy from FrameworkConfig — stored so the MCPL
   *  subsystem can be lazily initialized by connectMcplServer when the
   *  framework started with zero configured servers. */
  private mcplInferenceRoutingConfig: import('./mcpl/types.js').InferenceRoutingPolicy | null = null;
  /** Durable, non-Chronicle projection queue for messages removed by a branch. */
  private discordAwarenessOutbox: DiscordAwarenessOutbox | null = null;
  private discordAwarenessEmoji = DEFAULT_DISCORD_AWARENESS_EMOJI;
  private discordAwarenessDeadlineMs = DEFAULT_DISCORD_AWARENESS_DEADLINE_MS;
  /** Serialize per-server drains so reconnect and an online undo cannot race. */
  private discordAwarenessDrains: Map<string, Promise<DiscordAwarenessDrainOutcome>> = new Map();
  /** Framework-global inference gate; older generations cannot release it. */
  private discordAwarenessBarrier: DiscordAwarenessBarrier | null = null;
  private discordAwarenessBarrierGeneration = 0;

  // EventGate (null when FrameworkConfig.gate is omitted)
  private eventGate: EventGate | null = null;

  // Session-level token usage tracking (always-on)
  private usageTracker: UsageTracker;
  /** Presentation-only wall-clock zone; persistence remains UTC/epoch. */
  private readonly timeZone: string;

  private constructor(
    store: JsStore,
    ownsStore: boolean,
    membrane: Membrane,
    inferencePolicy: InferencePolicy,
    errorPolicy: ErrorPolicy,
    syncIntervalMs: number,
    maintenanceIntervalMs: number,
    processLoggingPersist: boolean,
    processLoggingBroadcast: boolean,
    timeZone: string,
    discordAwarenessOutbox: DiscordAwarenessOutbox | null,
    discordAwarenessEmoji: string,
    discordAwarenessDeadlineMs: number,
  ) {
    this.store = store;
    this.ownsStore = ownsStore;
    this.membrane = membrane;
    this.inferencePolicy = inferencePolicy;
    this.errorPolicy = errorPolicy;
    this.syncIntervalMs = syncIntervalMs;
    this.maintenanceIntervalMs = maintenanceIntervalMs;
    this.processLoggingPersist = processLoggingPersist;
    this.processLoggingBroadcast = processLoggingBroadcast;
    this.timeZone = timeZone;
    this.discordAwarenessOutbox = discordAwarenessOutbox;
    this.discordAwarenessEmoji = discordAwarenessEmoji;
    this.discordAwarenessDeadlineMs = discordAwarenessDeadlineMs;
    this.queue = new ProcessQueueImpl();
    this.usageTracker = new UsageTracker({
      emitTrace: (e: UsageUpdatedEvent) => this.emitTrace({ ...e }),
    });

    // Initialize module registry with callbacks
    this.moduleRegistry = new ModuleRegistry(store, this.queue, {
      getAgents: () => Array.from(this.agents.values()),
      addMessage: (p, c, m) => this.addMessage(p, c, m),
      editMessage: (id, c) => this.editMessage(id, c),
      removeMessage: (id) => this.removeMessage(id),
      getMessage: (id) => this.getMessage(id),
      queryMessages: (filter) => this.queryMessages(filter),
      pushEvent: (event) => this.pushEvent(event),
      onTrace: (listener) => this.onTrace(listener),
      // The ONLY entry that confers module origin — a private closure the
      // framework hands to its own module registry. The public
      // executeToolCall() is shared with model/ephemeral callers and always
      // stamps agent origin (see there).
      callTool: (call) => this.executeToolCallFrom(call, { kind: 'module' }),
      notifyOps: (kind, agentName, message, data) => this.notifyOps(kind, agentName, message, data),
    });
  }

  /**
   * Create and start the framework.
   */
  static async create(config: FrameworkConfig): Promise<AgentFramework> {
    // Create or use existing store
    let store: JsStore;
    let ownsStore: boolean;

    if (config.store) {
      store = config.store;
      ownsStore = false;
    } else if (config.storePath) {
      store = JsStore.openOrCreate({ path: config.storePath });
      ownsStore = true;
    } else {
      throw new Error('Either storePath or store must be provided');
    }

    // Register framework states
    try {
      store.registerState({ id: FRAMEWORK_STATE_ID, strategy: 'snapshot' });
    } catch {
      // Already registered
    }

    try {
      store.registerState({
        id: INFERENCE_LOG_ID,
        strategy: 'append_log',
        deltaSnapshotEvery: 100,
        fullSnapshotEvery: 20,
      });
    } catch {
      // Already registered
    }

    // The legacy single-map checkpoint state (TURN_CHECKPOINTS_ID) is no longer
    // registered for new stores — it's read-only fallback data in old ones.
    try {
      store.registerState({ id: TURN_CHECKPOINTS_TREE_ID, strategy: 'tree' });
    } catch (error) {
      if (!isStateExistsError(error)) throw error;
    }

    // Process logging config (default: disabled)
    const processLoggingPersist = config.processLogging?.persist ?? false;
    const processLoggingBroadcast = config.processLogging?.broadcast ?? false;

    // Register process log state only if persistence is enabled
    if (processLoggingPersist) {
      try {
        store.registerState({
          id: PROCESS_LOG_ID,
          strategy: 'append_log',
          deltaSnapshotEvery: 100,
          fullSnapshotEvery: 20,
        });
      } catch {
        // Already registered
      }
    }

    const discordAwarenessOutboxPath = config.discordAwarenessOutboxPath
      ?? (config.storePath ? defaultDiscordAwarenessOutboxPath(config.storePath) : undefined);
    const discordAwarenessOutbox = discordAwarenessOutboxPath
      ? new DiscordAwarenessOutbox(discordAwarenessOutboxPath)
      : null;

    const framework = new AgentFramework(
      store,
      ownsStore,
      config.membrane,
      config.inferencePolicy ?? new DefaultInferencePolicy(),
      config.errorPolicy ?? new DefaultErrorPolicy(),
      config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
      config.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
      processLoggingPersist,
      processLoggingBroadcast,
      resolveTimeZone(config.timeZone),
      discordAwarenessOutbox,
      config.discordAwarenessEmoji ?? DEFAULT_DISCORD_AWARENESS_EMOJI,
      normalizeDiscordAwarenessDeadline(config.discordAwarenessDeadlineMs),
    );

    // If an offline recovery process crashed after switching Chronicle but
    // before committing its prepared marker batch, the active branch is the
    // commit record. Promote it now; no quarantined content is read.
    if (discordAwarenessOutbox) {
      try {
        const activated = discordAwarenessOutbox.activatePreparedForBranch(
          store.currentBranch().name,
          store.listBranches(),
        );
        if (activated > 0) {
          console.error(
            `[discord-awareness] recovered ${activated} prepared batch(es) for active branch ${store.currentBranch().name}`,
          );
        }
      } catch (error) {
        // The branch may be safe, but reporting the framework ready while its
        // durable awareness projection is unreadable creates a half-ready
        // host whose data plane can never be released safely.
        throw new DiscordAwarenessAccountingError('startup reconciliation', error);
      }
    }

    // Restore persisted usage data (if any) from prior session
    framework.restoreUsageState();

    // Create agents
    for (const agentConfig of config.agents) {
      await framework.createAgent(agentConfig);
    }

    // Finish any branch-local suppression interrupted after Chronicle switched
    // branches. This runs before modules, MCPL connections, or inbound traffic.
    await framework.resumePreparedDiscordSuppressions();

    // Add modules
    for (const module of config.modules) {
      await framework.addModule(module);
    }

    // Initialize per-channel conversation routing (if configured)
    if (config.conversations) {
      if (!framework.agents.has(config.conversations.templateAgent)) {
        throw new Error(
          `conversations.templateAgent "${config.conversations.templateAgent}" ` +
          `is not a configured agent`
        );
      }
      framework.conversationRouter = new ConversationRouter(config.conversations);

      // Generation counters persist across restarts — reusing generation 1's
      // agent name after a restart would reopen (and re-seed) the previous
      // engagement's Chronicle namespace.
      try {
        store.registerState({ id: CONVERSATION_ROUTER_STATE_ID, strategy: 'snapshot' });
      } catch {
        // Already registered
      }
      try {
        const data = store.getStateJson(CONVERSATION_ROUTER_STATE_ID) as
          { generations?: Record<string, number> } | null;
        if (data?.generations) {
          framework.conversationRouter.hydrateGenerations(data.generations);
        }
      } catch {
        // No persisted state yet
      }
    }

    // Initialize EventGate if configured (before MCPL so it can be wired as trigger filter)
    if (config.gate) {
      const configPath = config.gate.configPath
        ?? (config.storePath
          ? join(config.storePath, 'config', 'gate.json')
          : './data/gate.json');
      framework.eventGate = new EventGate({
        configPath,
        initialConfig: config.gate.config,
        privilegedUsersPath: config.gate.privilegedUsersPath,
        emitTrace: (e) => framework.emitTrace(e as { type: TraceEvent['type']; [key: string]: unknown }),
        addMessage: (p, c, m) => framework.addMessage(p, c, m as MessageMetadata),
        requestInference: (agentName, reason, source) => {
          framework.pendingRequests.push({ agentName, reason, source, timestamp: Date.now() });
        },
        getAgentNames: () => [...framework.agents.keys()],
      });
    }

    // Liveness watchdog: fail hard if the main thread wedges (opt-in).
    if (config.watchdog?.enabled) {
      const { LivenessWatchdog } = await import('./runtime/liveness-watchdog.js');
      framework.livenessWatchdog = new LivenessWatchdog({
        enabled: true,
        thresholdMs: config.watchdog.thresholdMs,
        action: config.watchdog.action,
        reportPath: config.watchdog.reportPath
          ?? (config.storePath ? join(config.storePath, 'watchdog-wedge.jsonl') : undefined),
      });
      framework.livenessWatchdog.start();
    }

    // Stored for lazy MCPL initialization (connectMcplServer on a framework
    // that started with zero configured servers).
    framework.mcplInferenceRoutingConfig = config.inferenceRouting ?? null;

    // Client-side programmatic tool calling (code_execution). Config is only
    // retained when enabled — everything downstream gates on the field.
    framework.codeExecutionConfig = config.codeExecution?.enabled ? config.codeExecution : null;

    if (config.toolResultInlineMaxChars !== undefined) {
      const cap = config.toolResultInlineMaxChars;
      if (!Number.isFinite(cap) || cap < 1000) {
        throw new Error('FrameworkConfig.toolResultInlineMaxChars must be a number >= 1000');
      }
      framework.toolResultInlineMaxCharsConfig = Math.floor(cap);
    }

    // Restore resident-set inline caps (agent_settings) — durable like the
    // core runtime settings, same framework/state slot (antra + Sol, 08-06).
    for (const [agentName, cap] of Object.entries(framework.readPersistedToolResultInlineCaps())) {
      framework.toolResultInlineMaxCharsOverride.set(agentName, cap);
    }

    // Initialize MCPL subsystems if configured
    if (config.mcplServers && config.mcplServers.length > 0) {
      // Validate tool prefixes: no collisions with module names or between servers
      const moduleNames = new Set(config.modules.map(m => m.name));
      const prefixesSeen = new Map<string, string>(); // prefix → serverId
      for (const serverConfig of config.mcplServers) {
        const prefix = serverConfig.toolPrefix ?? `mcpl--${serverConfig.id}`;
        if (moduleNames.has(prefix)) {
          throw new Error(
            `MCPL server "${serverConfig.id}" toolPrefix "${prefix}" collides with module "${prefix}"`
          );
        }
        const existing = prefixesSeen.get(prefix);
        if (existing) {
          throw new Error(
            `MCPL server "${serverConfig.id}" toolPrefix "${prefix}" collides with server "${existing}"`
          );
        }
        prefixesSeen.set(prefix, serverConfig.id);
      }

      await framework.initializeMcpl(config.mcplServers, config.inferenceRouting);
    }

    // Diagnostics: `kill -USR2 <pid>` dumps live wake/inference state to stderr
    // (journal) without a restart — for catching the wake-wedge on the running
    // process. Shows the gate's `inferring` set + buffered-event count (the
    // wedge signature), active streams, and pending inference requests.
    try {
      process.on('SIGUSR2', () => {
        try {
          const gate = framework.eventGate?.inferenceDiagnostics() ?? null;
          console.error(
            '[diagnostics] ' + JSON.stringify({
              at: new Date().toISOString(),
              gate,
              activeStreams: [...framework.activeStreams.keys()],
              pendingRequests: framework.pendingRequests.length,
              agents: [...framework.agents.keys()],
            }),
          );
        } catch (err) {
          console.error('[diagnostics] dump failed:', err instanceof Error ? err.message : err);
        }
      });
    } catch {
      // SIGUSR2 not available on this platform — non-fatal.
    }

    return framework;
  }

  /**
   * Start the event loop.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.providerAdmissionClosed = false;
    this.loopPromise = this.runLoop();

    // Start periodic sync timer (if enabled)
    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        try {
          this.store.sync();
        } catch (error) {
          console.error('Periodic sync error:', error);
        }
      }, this.syncIntervalMs);
    }

    if (this.maintenanceIntervalMs > 0) {
      this.maintenanceTimer = setInterval(() => {
        this.startQueuedMaintenance();
      }, this.maintenanceIntervalMs);
      this.maintenanceTimer.unref?.();
      // Do not make a restored queue wait a full interval before its first
      // attempt. MCPL/module initialization has completed before start().
      this.startQueuedMaintenance();
    }
  }

  /**
   * Stop the event loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.providerAdmissionClosed = true;
    this.queue.close();

    // Kill running code_execution scripts before cancelling streams: a
    // zombie script must not keep firing side-effectful tool calls into a
    // framework that is shutting down.
    for (const runner of this.codeExecutionRunners.values()) {
      runner.dispose();
    }
    this.codeExecutionRunners.clear();
    // Background daemons die with the process (documented limitation) —
    // mark cancelled FIRST so their settle path stays silent (no crash-wake
    // into a framework that is shutting down).
    for (const record of this.backgroundScripts.values()) {
      if (record.status === 'running') {
        record.cancelled = true;
        record.status = 'cancelled';
      }
      record.runner.dispose();
    }
    this.backgroundScripts.clear();

    // A stopped host must never hang behind its own cooldown.
    this.cancelProviderAdmission();

    // Cancel all active streams
    for (const agent of this.agents.values()) {
      if (agent.state.status === 'streaming' ||
          (agent.state.status === 'waiting_for_tools' && agent.state.stream)) {
        agent.cancelStream();
      }
    }

    // Wait for all stream iteration handles to settle
    if (this.activeStreams.size > 0) {
      await Promise.allSettled(this.activeStreams.values());
    }

    // Stop sync timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.maintenancePass) {
      await this.maintenancePass;
    }

    if (this.loopPromise) {
      await this.loopPromise;
    }

    // Stop typing indicators
    this.channelRegistry?.stopAll();

    // Dispose EventGate (clear debounce timers)
    this.eventGate?.dispose();
    this.livenessWatchdog?.stop();

    // Stop modules and MCPL servers in parallel
    const shutdownPromises: Promise<void>[] = [this.moduleRegistry.stopAll()];
    if (this.mcplServerRegistry) {
      shutdownPromises.push(this.mcplServerRegistry.closeAll());
    }
    await Promise.all(shutdownPromises);

    // Final sync before closing
    try {
      this.store.sync();
    } catch (error) {
      console.error('Final sync error:', error);
    }

    if (this.ownsStore) {
      this.store.close();
    }
  }

  /**
   * Advance queued ContextManager work without requiring a new message.
   *
   * Tool definitions are refreshed first because compression replays stored
   * tool cycles and providers reject those requests when the corresponding
   * schemas are absent. Passes never overlap; each agent gets a bounded drain
   * so maintenance cannot monopolize the framework event loop.
   */
  private providerGate(agentName: string): LocalProviderGate {
    let gate = this.providerGates.get(agentName);
    if (!gate) {
      gate = { primaryDepth: 0, primaryPending: false, auxiliaryInFlight: 0,
        auxiliaryWaiters: [], idleWaiters: [], deferredAuxiliary: 0 };
      this.providerGates.set(agentName, gate);
    }
    return gate;
  }
  private providerGateBlocked(agentName: string): boolean {
    const gate = this.providerGates.get(agentName);
    return (gate?.primaryDepth ?? 0) > 0 || (gate?.primaryPending ?? false) ||
      this.providerAccelerationCooldowns.has(agentName);
  }
  private acquirePrimaryProviderGate(agentName: string): void {
    const gate = this.providerGate(agentName); gate.primaryPending = false; gate.primaryDepth++;
  }
  private releasePrimaryProviderGate(agentName: string): void {
    const gate = this.providerGate(agentName); gate.primaryDepth = Math.max(0, gate.primaryDepth - 1);
    this.flushAuxiliaryAdmission(agentName);
  }
  private flushAuxiliaryAdmission(agentName: string): void {
    const gate = this.providerGate(agentName);
    if (gate.primaryDepth > 0 || gate.primaryPending || this.providerAccelerationCooldowns.has(agentName)) return;
    for (const resolve of gate.auxiliaryWaiters.splice(0)) resolve();
  }
  private async waitForAuxiliaryIdle(agentName: string): Promise<void> {
    const gate = this.providerGate(agentName);
    if (gate.auxiliaryInFlight === 0) return;
    await new Promise<void>((resolve) => gate.idleWaiters.push(resolve));
  }
  private async withAuxiliaryAdmission<T>(agentName: string, run: () => Promise<T>): Promise<T> {
    const gate = this.providerGate(agentName);
    if (this.providerGateBlocked(agentName)) {
      gate.deferredAuxiliary++;
      try {
        await new Promise<void>((resolve) => gate.auxiliaryWaiters.push(resolve));
      } finally {
        gate.deferredAuxiliary = Math.max(0, gate.deferredAuxiliary - 1);
      }
    }
    if (this.providerAdmissionClosed) {
      throw new Error(`Provider admission closed while stopping (${agentName})`);
    }
    gate.auxiliaryInFlight++;
    try { return await run(); }
    finally {
      gate.auxiliaryInFlight = Math.max(0, gate.auxiliaryInFlight - 1);
      if (gate.auxiliaryInFlight === 0) for (const resolve of gate.idleWaiters.splice(0)) resolve();
    }
  }
  private auxiliaryMembraneFor(agentName: string): Membrane {
    const target = this.membrane as unknown as Record<PropertyKey, unknown>;
    return new Proxy(target, { get: (obj, prop, receiver) => {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === 'complete' && typeof value === 'function') {
        return (...args: unknown[]) => this.withAuxiliaryAdmission(
          agentName, () => Reflect.apply(value, this.membrane, args) as Promise<unknown>);
      }
      return typeof value === 'function' ? value.bind(this.membrane) : value;
    }}) as unknown as Membrane;
  }
  private accelerationCooldownMs(agentName: string, error: MembraneError): number {
    const base = error.retryAfterMs ?? this.providerAccelerationDefaultCooldownMs;
    let hash = 0; for (const ch of agentName) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
    const jitter = this.providerAccelerationJitterMs > 0 ? hash % (this.providerAccelerationJitterMs + 1) : 0;
    return Math.min(PROVIDER_ACCELERATION_MAX_COOLDOWN_MS, Math.max(1_000, base) + jitter);
  }
  private sameInferenceRequest(a: InferenceRequest, b: InferenceRequest): boolean {
    return a.agentName === b.agentName && a.reason === b.reason && a.source === b.source &&
      a.timestamp === b.timestamp && a.channelId === b.channelId;
  }
  private holdProviderAcceleration(agent: Agent, error: Error, trigger?: InferenceRequest): boolean {
    if (this.ephemeralRuns.has(agent.name) || this.conversationAgentHomes.has(agent.name) || !isOrganizationAccelerationRateLimit(error)) return false;
    const now = Date.now(); const delayMs = this.accelerationCooldownMs(agent.name, error);
    const existing = this.providerAccelerationCooldowns.get(agent.name);
    const held = existing?.heldRequests ?? [];
    if (trigger && !held.some((r) => this.sameInferenceRequest(r, trigger))) held.push(trigger);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.releaseProviderAccelerationCooldown(agent.name), delayMs); timer.unref?.();
    this.providerAccelerationCooldowns.set(agent.name, { startedAt: existing?.startedAt ?? now,
      until: now + delayMs, timer, heldRequests: held, reason: error.message,
      failures: (existing?.failures ?? 0) + 1 });
    const gate = this.providerGate(agent.name); gate.primaryPending = true;
    this.providerAccelerationRecoveries.set(agent.name, { startedAt: existing?.startedAt ?? now,
      failures: (existing?.failures ?? 0) + 1, heldRequests: held.length, reason: error.message });
    console.error(`[provider-cooldown] agent=${agent.name} organization acceleration 429 — ` +
      `holding primary/auxiliary for ${delayMs}ms; ${held.length} request(s) retained`);
    return true;
  }
  private releaseProviderAccelerationCooldown(agentName: string): void {
    const cooldown = this.providerAccelerationCooldowns.get(agentName); if (!cooldown) return;
    clearTimeout(cooldown.timer); this.providerAccelerationCooldowns.delete(agentName);
    const recovery = this.providerAccelerationRecoveries.get(agentName);
    if (recovery) { recovery.releasedAt = Date.now(); recovery.heldRequests = cooldown.heldRequests.length; }
    const requests = cooldown.heldRequests.length > 0 ? cooldown.heldRequests : [{ agentName,
      reason: 'provider-acceleration-retry', source: 'framework', timestamp: Date.now() } satisfies InferenceRequest];
    this.pendingRequests.push(...requests);
    console.error(`[provider-cooldown] agent=${agentName} released after ${Date.now() - cooldown.startedAt}ms — ` +
      `fresh compile queued with ${requests.length} retained request(s)`);
  }
  private recordProviderAccelerationRecovery(agent: Agent, request: NormalizedRequest | undefined, stopReason: string): void {
    const recovery = this.providerAccelerationRecoveries.get(agent.name); if (!recovery?.releasedAt) return;
    this.providerAccelerationRecoveries.delete(agent.name);
    const completedAt = Date.now();
    const receipt: ProviderAccelerationReceipt = {
      startedAt: recovery.startedAt,
      releasedAt: recovery.releasedAt,
      completedAt,
      cooldownMs: recovery.releasedAt - recovery.startedAt,
      waitedMs: completedAt - recovery.startedAt,
      failures: recovery.failures,
      heldRequests: recovery.heldRequests,
      messageCount: request?.messages.length ?? 0,
      toolCount: request?.tools?.length ?? 0,
      stopReason,
    };
    this.providerAccelerationLastRecovery.set(agent.name, receipt);
    // Operational receipt only: provider admission must never author resident memory.
    console.error(`[provider-cooldown] recovered ${JSON.stringify({ agent: agent.name, ...receipt })}`);
  }
  private cancelProviderAdmission(): void {
    for (const cooldown of this.providerAccelerationCooldowns.values()) clearTimeout(cooldown.timer);
    this.providerAccelerationCooldowns.clear(); this.providerAccelerationRecoveries.clear();
    for (const gate of this.providerGates.values()) {
      gate.primaryDepth = 0; gate.primaryPending = false;
      for (const resolve of gate.auxiliaryWaiters.splice(0)) resolve();
      for (const resolve of gate.idleWaiters.splice(0)) resolve();
    }
    this.providerGates.clear();
  }

  private startQueuedMaintenance(): void {
    if (this.maintenancePass || !this.running) return;
    const pass = this.runQueuedMaintenance().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        '[context-maintenance] pass failed:',
        reason,
      );
      this.opsAlert(
        'context-maintenance-failed',
        'framework',
        reason,
        { data: { scope: 'pass' } },
      );
    });
    this.maintenancePass = pass;
    void pass.finally(() => {
      if (this.maintenancePass === pass) this.maintenancePass = null;
    });
  }

  private async runQueuedMaintenance(): Promise<void> {
    const queued = [...this.agents.values()].flatMap((agent) => {
      const cm = agent.getContextManager();
      const tools = this.getToolsForAgent(agent.name).filter((tool) => agent.canUseTool(tool.name));
      cm.setToolDefinitions(tools);
      if (this.providerGateBlocked(agent.name)) return [];
      if (cm.isReady()) return [];
      const pending = cm.getPendingWork()?.description;
      const progress = this.contextProgress(cm);
      const record: ContextMaintenanceAgentRun = {
        agentName: agent.name,
        startedAt: Date.now(),
        ticks: 0,
        readyBefore: false,
        ...(pending ? { pendingBefore: pending } : {}),
        ...(progress ? { progressBefore: progress } : {}),
      };
      return [{
        agent,
        cm,
        record,
      }];
    });
    if (queued.length === 0) return;

    const run: ContextMaintenanceRun = {
      id: ++this.maintenanceRunId,
      startedAt: Date.now(),
      agents: queued.map(item => item.record),
    };
    this.currentMaintenanceRun = run;

    try {
      await Promise.all(queued.map(async ({ agent, cm, record }) => {
        try {
          for (
            let i = 0;
            i < MAINTENANCE_TICKS_PER_PASS && this.running && !cm.isReady();
            i++
          ) {
            await cm.tick();
            record.ticks++;
          }
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          console.error(`[context-maintenance] agent=${agent.name} failed:`, record.error);
          this.opsAlert(
            'context-maintenance-failed',
            agent.name,
            record.error,
            {
              data: {
                scope: 'agent',
                ...(record.pendingBefore ? { pending: record.pendingBefore } : {}),
                ...(record.progressBefore ? { progress: record.progressBefore } : {}),
              },
            },
          );
        } finally {
          const pending = cm.getPendingWork()?.description;
          record.finishedAt = Date.now();
          record.readyAfter = cm.isReady();
          if (pending) record.pendingAfter = pending;
          const progress = this.contextProgress(cm);
          if (progress) record.progressAfter = progress;
        }
      }));
    } finally {
      run.finishedAt = Date.now();
      run.agents.sort((a, b) => a.agentName.localeCompare(b.agentName));
      this.currentMaintenanceRun = null;
      this.maintenanceHistory.unshift(run);
      if (this.maintenanceHistory.length > 50) this.maintenanceHistory.length = 50;
    }
  }

  private contextProgress(cm: ContextManager): Record<string, unknown> | undefined {
    const strategy = cm.getStrategy() as {
      getProgressSnapshot?: () => unknown;
    };
    if (typeof strategy.getProgressSnapshot !== 'function') return undefined;
    const progress = strategy.getProgressSnapshot();
    return progress && typeof progress === 'object'
      ? progress as Record<string, unknown>
      : undefined;
  }

  /**
   * Push a process event to the queue.
   */
  pushEvent(event: ProcessEvent): void {
    this.queue.push(event);
    this.emitTrace({ type: 'process:received', processEvent: event });
  }

  /**
   * Add a trace event listener for observability.
   */
  onTrace(listener: TraceEventListener): () => void {
    this.traceListeners.push(listener);
    // Return an unsubscribe so callers with a bounded lifetime (e.g. modules
    // that get torn down and recreated on session switch) don't leak
    // listeners. Existing callers that ignore the return value are unaffected.
    return () => {
      const idx = this.traceListeners.indexOf(listener);
      if (idx >= 0) this.traceListeners.splice(idx, 1);
    };
  }

  /**
   * Public accessor for the MCPL channel registry.
   * Null when no MCPL servers are configured.
   * Modules that need channel-level operations (typing indicators, default publish channel,
   * etc.) obtain them here.
   */
  get channels(): ChannelRegistry | null {
    return this.channelRegistry;
  }

  /**
   * Remove a trace event listener.
   */
  offTrace(listener: TraceEventListener): void {
    const index = this.traceListeners.indexOf(listener);
    if (index >= 0) {
      this.traceListeners.splice(index, 1);
    }
  }

  /**
   * Add a module at runtime.
   */
  async addModule(module: Module): Promise<void> {
    await this.moduleRegistry.addModule(module);
    this.emitTrace({ type: 'module:added', moduleName: module.name });
  }

  /**
   * Remove a module at runtime.
   */
  async removeModule(name: string): Promise<void> {
    await this.moduleRegistry.removeModule(name);
    this.emitTrace({ type: 'module:removed', moduleName: name });
  }

  /**
   * Get an agent by name.
   */
  getAgent(name: string): Agent | null {
    return this.agents.get(name) ?? null;
  }

  /**
   * Get all agents.
   */
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get the per-channel conversation router (null unless config.conversations
   * was set). Exposed for modules/UIs that surface active engagements.
   */
  getConversationRouter(): ConversationRouter | null {
    return this.conversationRouter;
  }

  /**
   * Abort an in-flight inference for an agent.
   */
  abortInference(agentName: string, reason?: string): boolean {
    const agent = this.agents.get(agentName);
    if (!agent) {
      return false;
    }
    const result = agent.abortInference(reason);
    if (result) {
      this.emitTrace({ type: 'inference:aborted', agentName, reason, durationMs: result.durationMs });
    }
    return !!result;
  }

  /**
   * Get all registered modules.
   */
  getAllModules(): Module[] {
    return this.moduleRegistry.getAllModules();
  }

  /**
   * Get all available tools from all modules and MCPL servers.
   */
  getAllTools(): import('./types/index.js').ToolDefinition[] {
    const moduleTools = this.moduleRegistry.getAllTools();
    const channelTools = this.channelRegistry?.getChannelTools() ?? [];
    const gateTools = this.eventGate
      ? [
          this.eventGate.getToolDefinition(),
          ...AgentFramework.SLEEP_TOOLS,
          ...AgentFramework.WAKE_RULE_TOOLS,
          AgentFramework.EVENT_TAGS_TOOL,
        ]
      : [];
    return [
      ...moduleTools,
      // Utilities collapse into one slot; absent entirely when none exist.
      ...(this.moduleRegistry.getAllUtilities().length > 0 ? [UTILS_TOOL] : []),
      ...this.mcplTools,
      ...channelTools,
      ...gateTools,
      this.buildAgentSettingsTool(),
      ...(this.getWorkspaceModule()
        ? [AgentFramework.SAVE_IMAGE_TOOL, AgentFramework.READ_IMAGE_TOOL]
        : []),
      ...(this.codeExecutionConfig
        ? [buildCodeExecutionToolDefinition(this.codeExecutionConfig)]
        : []),
    ];
  }

  /** The registered workspace module, if any (used by save_image). */
  private getWorkspaceModule(): WorkspaceModule | undefined {
    const module = this.moduleRegistry.getAllModules().find((m) => m.name === 'workspace');
    return module && typeof (module as WorkspaceModule).writeBinary === 'function'
      ? (module as WorkspaceModule)
      : undefined;
  }

  /** Core agent_settings keys — extension keys must not collide with these. */
  private static readonly AGENT_SETTINGS_CORE_KEYS = [
    'context_budget_tokens',
    'tail_tokens',
    'transition_pace_tokens',
    'same_round_think_text_policy',
  ];

  /**
   * Collect module-declared agent_settings extensions (Module.getAgentSettingsExtension),
   * keyed by owning module name. Extensions whose keys collide with the core
   * settings or an earlier extension are skipped loudly — silent shadowing
   * would make updates route to the wrong owner.
   */
  private collectAgentSettingsExtensions(): Map<string, AgentSettingsExtension> {
    const result = new Map<string, AgentSettingsExtension>();
    const taken = new Set<string>(AgentFramework.AGENT_SETTINGS_CORE_KEYS);
    // Framework-owned extension: the resident's tool-result inline cap.
    // Registered through the same extension surface modules use so
    // get/update/reset all work with zero extra plumbing. DURABLE: persisted
    // in framework state and restored at create, like the core runtime
    // settings (antra + Sol, 08-06); reset returns to the residence default.
    {
      const ext = this.spillSettingsExtension();
      ext.keys.forEach((k) => taken.add(k));
      result.set('_framework', ext);
    }
    for (const module of this.moduleRegistry.getAllModules()) {
      const ext = module.getAgentSettingsExtension?.();
      if (!ext) continue;
      const collision = ext.keys.find((k) => taken.has(k));
      if (collision) {
        console.error(
          `[agent-settings] extension from module '${module.name}' skipped: key '${collision}' already taken`,
        );
        continue;
      }
      ext.keys.forEach((k) => taken.add(k));
      result.set(module.name, ext);
    }
    return result;
  }

  /** agent_settings extension for the spill gate (see spillOrTruncate). */
  private spillSettingsExtension(): AgentSettingsExtension {
    return {
      properties: {
        tool_result_inline_max_chars: {
          type: 'number',
          description:
            'Inline size cap (chars) for tool results (successes and errors) and ' +
            'background-script wake payloads. Content over the cap is written to a workspace ' +
            'file under tool-results/ and replaced by a truncated preview + file reference. ' +
            'This is YOUR durable setting: it persists across restarts, like your other ' +
            'agent_settings. Update it when you want a different inline size; reset restores ' +
            'the residence default. The effective cap is min(your value, your strategy\'s ' +
            'per-message bound) — the bound is a safety ceiling, and the full content is ' +
            'always in the spill file. get reports desired/_effective/_source/_clamped_by.',
        },
      },
      keys: ['tool_result_inline_max_chars'],
      get: (agentName: string) => {
        const agent = this.agents.get(agentName);
        const resolved = agent ? this.resolveToolResultInlineCap(agent) : null;
        return {
          tool_result_inline_max_chars:
            this.toolResultInlineMaxCharsOverride.get(agentName) ?? null,
          tool_result_inline_max_chars_effective: resolved?.cap ?? null,
          tool_result_inline_max_chars_source: resolved?.source ?? null,
          tool_result_inline_max_chars_clamped_by: resolved?.clampedBy ?? null,
        };
      },
      update: (agentName: string, patch: Record<string, unknown>) => {
        const n = Number(patch.tool_result_inline_max_chars);
        if (!Number.isFinite(n) || n < 1000) {
          throw new Error('tool_result_inline_max_chars must be a number >= 1000');
        }
        this.toolResultInlineMaxCharsOverride.set(agentName, Math.floor(n));
        this.persistToolResultInlineCap(agentName, Math.floor(n));
        return { tool_result_inline_max_chars: Math.floor(n) };
      },
      reset: (agentName: string, keys?: string[]) => {
        if (!keys || keys.includes('tool_result_inline_max_chars')) {
          this.toolResultInlineMaxCharsOverride.delete(agentName);
          this.persistToolResultInlineCap(agentName, null);
        }
        return { tool_result_inline_max_chars: null };
      },
    };
  }

  private captureInferenceToolSnapshot(agent: Agent): InferenceToolSnapshot {
    return {
      sameRoundThinkTextPolicy: agent.getEffectiveSameRoundThinkTextPolicy(),
    };
  }

  private buildThinkTool(
    policy: SameRoundThinkTextPolicy,
  ): import('./types/index.js').ToolDefinition {
    return {
      name: 'think',
      description:
        'Reason privately. The think({content}) argument stays in your own context and is NOT sent ' +
        'to channels or other surfaces. ' +
        (policy === 'private'
          ? 'Your current same_round_think_text_policy is private, so ordinary text emitted in the SAME native assistant round as think() is withheld from channel routing. Later rounds without think() route normally.'
          : 'Your current same_round_think_text_policy is public, so ordinary text emitted in the SAME native assistant round as think() may still be routed publicly as your speech. Later rounds without think() route normally.'
        ) +
        ' Use think() to work things out privately. To inspect or change this policy, use agent_settings get/update on same_round_think_text_policy. To deliberately not reply this turn, call skip_reply instead.',
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
    };
  }

  /** agent_settings tool definition with module extension fields merged in. */
  private buildAgentSettingsTool(): import('./types/index.js').ToolDefinition {
    const base = AgentFramework.AGENT_SETTINGS_TOOL;
    const extensions = this.collectAgentSettingsExtensions();
    if (extensions.size === 0) return base;
    const baseSchema = base.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    const extProperties: Record<string, unknown> = {};
    const extKeys: string[] = [];
    for (const ext of extensions.values()) {
      Object.assign(extProperties, ext.properties);
      extKeys.push(...ext.keys);
    }
    const settingsProp = baseSchema.properties.settings as { items?: { enum?: string[] } };
    return {
      ...base,
      description:
        base.description +
        ` Additional host-managed settings also live here: ${extKeys.join(', ')}.`,
      inputSchema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          ...extProperties,
          settings: {
            ...(baseSchema.properties.settings as Record<string, unknown>),
            items: {
              ...(settingsProp.items as Record<string, unknown>),
              enum: [...(settingsProp.items?.enum ?? []), ...extKeys],
            },
          },
        },
      } as unknown as import('./types/index.js').ToolDefinition['inputSchema'],
    };
  }

  private getToolsForAgent(
    agentName: string,
    snapshot?: InferenceToolSnapshot,
  ): import('./types/index.js').ToolDefinition[] {
    return this.getAllTools().map((tool) => {
      if (tool.name === 'think') {
        return this.buildThinkTool(
          snapshot?.sameRoundThinkTextPolicy
            ?? this.getAgentRuntimeSettings(agentName).sameRoundThinkTextPolicy,
        );
      }
      return tool;
    });
  }

  getAgentRuntimeSettings(agentName: string): AgentRuntimeSettingsSnapshot {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    return agent.getRuntimeSettings();
  }

  /**
   * Apply runtime settings.
   *
   * `opts.persist: false` makes the change EPHEMERAL: it takes effect live but
   * is not written to the `framework/state` slot, so a restart reverts it. That
   * is the mode for operator experiments ("change it, watch, revert") — the
   * default persists, because a durable operational change should survive a
   * bounce like every other override.
   *
   * Nothing here notifies the agent. Discovery is deliberately PULL: the agent
   * can read current settings any time via the `agent_settings` tool's `get`
   * action, which costs no context perturbation. Pushing a notice injects text
   * into the very context being tuned — it invalidates the KV prefix and can
   * itself trip a classifier — so callers opt into that explicitly rather than
   * getting it by default.
   *
   * KNOWN LIMITATION of `persist: false`: the change still lands in the agent's
   * in-memory override map, and `persistAgentRuntimeSettings` writes that whole
   * map. So a LATER persisting call promotes any still-live ephemeral change to
   * durable as a side effect. Ephemeral means "not written by THIS call", not
   * "can never be written". Reset the ephemeral key before persisting something
   * else if that matters. Making it airtight needs per-key ephemeral tracking
   * inside Agent.
   */
  updateAgentRuntimeSettings(
    agentName: string,
    patch: AgentRuntimeSettingsPatch,
    opts?: { persist?: boolean },
  ): AgentRuntimeSettingsSnapshot {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    const result = agent.updateRuntimeSettings(patch);
    if (opts?.persist !== false) {
      this.persistAgentRuntimeSettings(agentName, agent.getRuntimeSettingsOverrides());
    }
    return result;
  }

  resetAgentRuntimeSettings(
    agentName: string,
    keys?: Array<keyof AgentRuntimeSettingsPatch>,
    opts?: { persist?: boolean },
  ): AgentRuntimeSettingsSnapshot {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    const result = agent.resetRuntimeSettings(keys);
    if (opts?.persist !== false) {
      this.persistAgentRuntimeSettings(agentName, agent.getRuntimeSettingsOverrides());
    }
    return result;
  }

  cancelAgentRuntimeSettingsTransition(agentName: string): AgentRuntimeSettingsSnapshot {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    const result = agent.cancelRuntimeSettingsTransition();
    this.persistAgentRuntimeSettings(agentName, agent.getRuntimeSettingsOverrides());
    return result;
  }

  /** Counts-only context-maintenance diagnostics for authenticated debug UIs. */
  getContextMaintenanceSnapshot(): ContextMaintenanceSnapshot {
    const agents = [...this.agents.values()].map((agent) => {
      const cm = agent.getContextManager();
      const pending = cm.getPendingWork()?.description;
      const progress = this.contextProgress(cm);
      return {
        agentName: agent.name,
        ready: cm.isReady(),
        ...(pending ? { pending } : {}),
        ...(progress ? { progress } : {}),
      };
    });
    return structuredClone({
      intervalMs: this.maintenanceIntervalMs,
      ticksPerPass: MAINTENANCE_TICKS_PER_PASS,
      current: this.currentMaintenanceRun,
      history: this.maintenanceHistory,
      agents,
    });
  }

  /**
   * Build the membrane-normalized request that WOULD be emitted if `agentName`
   * were activated right now — WITHOUT running inference, opening a stream, or
   * mutating agent state. Intended for debug/preview tooling.
   *
   * Transparency contract (default): the preview is side-effect-free and
   * leaves no trace on the system. It does only read-only work —
   * `ContextManager.compile` (which never triggers compression itself;
   * compression runs in the background out-of-band), tool filtering, and
   * system-prompt assembly — then delegates to `Agent.buildActivationRequest`.
   * No tokens are spent, nothing is written to Chronicle, and no external
   * MCPL server is contacted.
   *
   * The trade-off is fidelity: the dynamically-gathered ContextInjection[]
   * (module `gatherContext` + MCPL `beforeInference` hooks) are NOT included
   * by default, because gathering them is not transparent —
   *   - module `gatherContext` can run inference (e.g. RetrievalModule makes
   *     Haiku calls — real token cost and latency), and
   *   - MCPL `beforeInference` hooks are arbitrary RPCs to external servers
   *     with side effects, and a preview never sends the paired
   *     `afterInference`, which can leave a stateful server half-open.
   *
   * Pass `{ injections: true }` to opt into full-fidelity gathering and accept
   * those side effects (byte-faithful to a real activation's injected context).
   */
  async previewActivation(
    agentName: string,
    opts?: { injections?: boolean; budget?: TokenBudget }
  ): Promise<NormalizedRequest> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const tools = this.getToolsForAgent(agentName).filter((t) => agent.canUseTool(t.name));

    // An explicit budget compiles against a HYPOTHETICAL window instead of the
    // agent's live one. That also suppresses transition-settling in
    // compileWithInjections (which only settles when no budget is passed), so
    // previewing a smaller window cannot advance a converging descent.
    // Default: no dynamic injection gathering → fully transparent (no
    // inference, no Chronicle writes, no external RPC). Opt in explicitly.
    if (!opts?.injections) {
      return agent.buildActivationRequest(tools, undefined, opts?.budget);
    }

    // Full-fidelity path: mirrors startAgentStream's injection gathering.
    // NOT transparent — see the doc comment above.
    let injections: ContextInjection[] | undefined;

    // Module gatherContext (fail-open, matches startAgentStream)
    try {
      const moduleInjections = await this.moduleRegistry.gatherContext(agentName);
      const scopedModuleInjections = this.scopeInjectionsForAgent(agentName, moduleInjections);
      if (scopedModuleInjections.length > 0) {
        injections = scopedModuleInjections;
      }
    } catch (error) {
      console.error('Module gatherContext error (preview):', error);
    }

    // MCPL beforeInference hooks (fail-open). Note: the paired afterInference
    // is intentionally never sent here — this is a preview, not a real turn.
    if (this.hookOrchestrator) {
      try {
        const hookParams = this.buildBeforeInferenceParams(agent);
        const hookInjections = this.scopeInjectionsForAgent(
          agentName,
          await this.hookOrchestrator.beforeInference(hookParams),
        );
        if (hookInjections.length > 0) {
          injections = injections ? [...injections, ...hookInjections] : hookInjections;
        }
      } catch (error) {
        console.error('beforeInference hook error (preview):', error);
      }
    }

    return agent.buildActivationRequest(tools, injections, opts?.budget);
  }

  /**
   * Non-committing preview of the FOLD PLAN at a hypothetical budget and/or
   * context settings — the numbers behind an operator's "what happens if I set
   * the budget to X" before they apply it.
   *
   * Unlike `previewActivation` (which renders a request), this returns the
   * picker's plan: resulting tokens, whether it fits, how many summaries would
   * have to be produced first, and the per-chunk fold levels. Commits nothing:
   * no resolution persistence, no compression enqueue, no transition
   * bookkeeping — see `AutobiographicalStrategy.previewContext`.
   *
   * Returns null when the agent's strategy has no fold plan (non-adaptive).
   */
  previewContextSettings(
    agentName: string,
    budgetTokens: number,
    overrides?: Record<string, unknown>,
    opts?: { render?: boolean },
  ): unknown {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    const cm = agent.getContextManager() as unknown as {
      previewContext?: (
        budget: TokenBudget,
        overrides?: Record<string, unknown>,
        opts?: { render?: boolean },
      ) => unknown;
    };
    if (typeof cm.previewContext !== 'function') return null;
    // reserveForResponse mirrors the live compile so the previewed middle is
    // comparable to what the agent actually gets. `opts.render` additionally
    // returns the rendered entries — opt-in, since they are megabytes on a
    // large store, and older context-manager builds ignore the argument.
    return cm.previewContext(
      { maxTokens: budgetTokens, reserveForResponse: agent.maxTokens },
      overrides,
      opts,
    );
  }

  /**
   * Check if process logging is enabled.
   */
  isProcessLoggingEnabled(): { persist: boolean; broadcast: boolean } {
    return {
      persist: this.processLoggingPersist,
      broadcast: this.processLoggingBroadcast,
    };
  }

  /**
   * Get the underlying store.
   */
  getStore(): JsStore {
    return this.store;
  }

  /**
   * Get a registered module by name.
   */
  getModule(name: string): Module | null {
    return this.moduleRegistry.getModule(name);
  }

  // =========================================================================
  // Wake-rule surface (gate policy mutation) — backs wake_add_rule /
  // wake_remove_rule and lets host modules compose higher-level wake modes
  // (e.g. an "every-message-debounced" channel mode) without reaching into
  // the private EventGate.
  // =========================================================================

  /**
   * Add or replace (upsert) a gate policy at runtime. Validated and persisted
   * to gate.json; hot-applied in memory. Throws if no gate is configured or the
   * policy is invalid. Placement: `'prepend'` puts a rule ahead of EVERYTHING
   * (including addressed-message wake rules — see EventGate.lintShadows);
   * `{before: name}` / `{after: name}` anchor it against a specific rule,
   * which is usually what a sampler or debounce actually wants.
   */
  addGatePolicy(
    rawPolicy: unknown,
    options?: { position?: 'append' | 'prepend' | { before: string } | { after: string } },
  ): import('./gate/types.js').GatePolicy {
    if (!this.eventGate) {
      throw new Error('No EventGate configured (FrameworkConfig.gate is unset).');
    }
    return this.eventGate.addPolicy(rawPolicy, options);
  }

  /**
   * Remove a gate policy by name at runtime. Returns false if it didn't exist.
   * Throws if no gate is configured.
   */
  removeGatePolicy(name: string): boolean {
    if (!this.eventGate) {
      throw new Error('No EventGate configured (FrameworkConfig.gate is unset).');
    }
    return this.eventGate.removePolicy(name);
  }

  /** Current gate policy names (freshest on-disk view). Empty when no gate. */
  getGatePolicyNames(): string[] {
    return this.eventGate?.listPolicyNames() ?? [];
  }

  /**
   * Get the Membrane instance.
   */
  getMembrane(): Membrane {
    return this.membrane;
  }

  getSessionUsage(): SessionUsageSnapshot {
    return this.usageTracker.getSnapshot();
  }

  private restoreUsageState(): void {
    try {
      const data = this.store.getStateJson(FRAMEWORK_STATE_ID);
      if (data && typeof data === 'object' && (data as any).usage) {
        const restored = (data as any).usage as PersistedUsageState;
        this.usageTracker = new UsageTracker({
          emitTrace: (e: UsageUpdatedEvent) => this.emitTrace({ ...e }),
          restored,
        });
      }
    } catch {
      // No prior state or corrupt — start fresh (already initialized in constructor)
    }
  }

  private persistUsageState(): void {
    try {
      const data = this.store.getStateJson(FRAMEWORK_STATE_ID);
      const state = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      state.usage = this.usageTracker.toJSON();
      this.store.setStateJson(FRAMEWORK_STATE_ID, state);
    } catch {
      // Non-fatal — usage tracking is best-effort
    }
  }

  private readAgentRuntimeSettings(agentName: string): AgentRuntimeSettingsOverrides | null {
    try {
      const data = this.store.getStateJson(FRAMEWORK_STATE_ID) as {
        agentRuntimeSettings?: Record<string, AgentRuntimeSettingsOverrides>;
      } | null;
      const stored = data?.agentRuntimeSettings?.[agentName];
      return stored ? { ...stored } : null;
    } catch {
      return null;
    }
  }

  private validatePersistedAgentRuntimeSettings(
    agentName: string,
    overrides: AgentRuntimeSettingsOverrides,
  ): AgentRuntimeSettingsOverrides {
    if (
      overrides.sameRoundThinkTextPolicy !== undefined &&
      overrides.sameRoundThinkTextPolicy !== 'public' &&
      overrides.sameRoundThinkTextPolicy !== 'private'
    ) {
      throw new Error(
        `Invalid persisted sameRoundThinkTextPolicy for agent "${agentName}": ${JSON.stringify(overrides.sameRoundThinkTextPolicy)}`,
      );
    }
    return overrides;
  }

  /** Load resident-set inline caps from framework state, dropping (loudly)
   *  anything that fails the same validation the live update enforces. */
  private readPersistedToolResultInlineCaps(): Record<string, number> {
    try {
      const data = this.store.getStateJson(FRAMEWORK_STATE_ID) as {
        toolResultInlineCaps?: Record<string, unknown>;
      } | null;
      const out: Record<string, number> = {};
      for (const [name, value] of Object.entries(data?.toolResultInlineCaps ?? {})) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1000) {
          out[name] = Math.floor(n);
        } else {
          console.error(
            `[agent-settings] dropping invalid persisted tool_result_inline_max_chars for '${name}': ${JSON.stringify(value)}`,
          );
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Write (cap) or clear (null) one agent's resident-set inline cap. */
  private persistToolResultInlineCap(agentName: string, cap: number | null): void {
    const data = this.store.getStateJson(FRAMEWORK_STATE_ID);
    const state = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const all = {
      ...((state.toolResultInlineCaps as Record<string, number> | undefined) ?? {}),
    };
    if (cap === null) delete all[agentName];
    else all[agentName] = cap;
    if (Object.keys(all).length === 0) delete state.toolResultInlineCaps;
    else state.toolResultInlineCaps = all;
    this.store.setStateJson(FRAMEWORK_STATE_ID, state);
  }

  private persistAgentRuntimeSettings(
    agentName: string,
    overrides: AgentRuntimeSettingsOverrides,
  ): void {
    const data = this.store.getStateJson(FRAMEWORK_STATE_ID);
    const state = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const all = {
      ...((state.agentRuntimeSettings as Record<string, AgentRuntimeSettingsOverrides> | undefined) ?? {}),
    };
    if (Object.keys(overrides).length === 0) delete all[agentName];
    else all[agentName] = { ...overrides };
    state.agentRuntimeSettings = all;
    this.store.setStateJson(FRAMEWORK_STATE_ID, state);
  }

  /**
   * Create an ephemeral agent that is NOT registered in the main event loop.
   *
   * Used by SubagentModule (and similar) to create short-lived agents
   * that are driven externally (not by the framework's event loop).
   * The returned agent has its own ContextManager on a namespaced state
   * within the framework's shared Chronicle store — messages go to
   * `{namespace}/messages`, context log to `{namespace}/context`.
   *
   * Data persists after cleanup for investigation and cross-revert.
   * Call cleanup() when done to release the ContextManager.
   */
  async createEphemeralAgent(config: AgentConfig): Promise<{
    agent: Agent;
    contextManager: ContextManager;
    cleanup: () => void;
  }> {
    const namespace = `subagent/${config.name}`;

    const contextManager = await ContextManager.open({
      store: this.store,
      namespace,
      isolate: true,
      strategy: config.strategy ?? new PassthroughStrategy(),
      membrane: this.membrane,
      debugLogContext: !!process.env.DEBUG_CONTEXT,
    });

    const agent = new Agent(config, contextManager, this.membrane);

    const cleanup = () => {
      // Don't close the store — it's shared. Just release the CM.
      // Data persists in the store under the namespace for investigation.
    };

    return { agent, contextManager, cleanup };
  }

  private createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Liveness ping for an active ephemeral run (no-op otherwise). */
  private touchEphemeralRun(agentName: string, inferenceStarted = false): void {
    const run = this.ephemeralRuns.get(agentName);
    if (!run) return;
    if (inferenceStarted) {
      run.inferenceStarted = true;
    }
    run.lastActivity = Date.now();
  }

  private recordEphemeralToolCalls(agentName: string, count: number): void {
    const run = this.ephemeralRuns.get(agentName);
    if (!run) return;
    run.toolCallsCount += count;
    run.lastActivity = Date.now();
  }

  /** Settle an active ephemeral run (no-op for resident agents). The tool-call
   *  count comes from the run's own counter — the single source of truth,
   *  which unlike a per-stream local survives budget restarts. */
  private settleAgent(
    agentName: string,
    outcome: { stopReason: AgentSettleResult['stopReason']; speech: string; error?: string },
  ): void {
    const run = this.ephemeralRuns.get(agentName);
    if (!run) return;
    run.lastActivity = Date.now();
    if (outcome.stopReason === 'exhausted') {
      run.settle.reject(new Error(outcome.error ?? 'Unknown error'));
      return;
    }
    run.settle.resolve({
      stopReason: outcome.stopReason,
      speech: outcome.speech,
      toolCallsCount: run.toolCallsCount,
    });
  }

  /**
   * Run an ephemeral agent to completion through the framework's event loop.
   *
   * The agent is temporarily registered, inference is triggered, and the
   * framework drives the stream (emitting traces, logging, dispatching tools).
   * Returns the agent's speech output when it finishes (no more tool calls).
   *
   * The caller provides a pre-created agent + contextManager (from createEphemeralAgent).
   * The task message should already be in the context manager.
   */
  async runEphemeralToCompletion(
    agent: Agent,
    contextManager: ContextManager,
    watchdogs?: { startupTimeoutMs?: number; idleTimeoutMs?: number; idlePollMs?: number },
  ): Promise<{ speech: string; toolCallsCount: number }> {
    // Register temporarily so the event loop can drive it
    this.agents.set(agent.name, agent);
    const run: EphemeralRun = {
      settle: this.createDeferred<AgentSettleResult>(),
      inferenceStarted: false,
      lastActivity: Date.now(),
      toolCallsCount: 0,
    };
    this.ephemeralRuns.set(agent.name, run);

    const STARTUP_TIMEOUT_MS = watchdogs?.startupTimeoutMs ?? 30_000;
    // After inference has started, give it 15 minutes of activity-bounded
    // life. The stream driver refreshes the deadline as it makes progress;
    // sustained silence trips it.
    const COMPLETION_IDLE_TIMEOUT_MS = watchdogs?.idleTimeoutMs ?? 15 * 60_000;
    const IDLE_POLL_MS = watchdogs?.idlePollMs ?? 30_000;

    let startupWatchdog: ReturnType<typeof setTimeout> | null = null;
    let completionWatchdog: ReturnType<typeof setInterval> | null = null;

    const startupTimeout = new Promise<never>((_, reject) => {
      startupWatchdog = setTimeout(() => {
        if (!run.inferenceStarted) {
          reject(new Error(
            `Ephemeral agent "${agent.name}" failed to start inference within ` +
            `${STARTUP_TIMEOUT_MS}ms — zombie detected. The event loop may have ` +
            `stalled or the inference request was dropped.`
          ));
        }
      }, STARTUP_TIMEOUT_MS);
    });

    const completionIdleTimeout = new Promise<never>((_, reject) => {
      completionWatchdog = setInterval(() => {
        if (!run.inferenceStarted) return;
        const idle = Date.now() - run.lastActivity;
        if (idle > COMPLETION_IDLE_TIMEOUT_MS) {
          reject(new Error(
            `Ephemeral agent "${agent.name}" stalled: no stream-driver activity for ` +
            `${Math.round(idle / 1000)}s after inference started (threshold ` +
            `${Math.round(COMPLETION_IDLE_TIMEOUT_MS / 1000)}s). Stream likely ` +
            `dropped or terminal event was lost.`
          ));
        }
      }, IDLE_POLL_MS);
    });

    try {
      // Trigger inference after the settle promise is registered.
      this.pendingRequests.push({
        agentName: agent.name,
        reason: 'ephemeral',
        source: 'subagent',
        timestamp: Date.now(),
      });

      const result = await Promise.race([
        run.settle.promise,
        startupTimeout,
        completionIdleTimeout,
      ]);
      return { speech: result.speech, toolCallsCount: result.toolCallsCount };
    } finally {
      if (startupWatchdog) clearTimeout(startupWatchdog);
      if (completionWatchdog) clearInterval(completionWatchdog);
      this.ephemeralRuns.delete(agent.name);
      this.agents.delete(agent.name);
      // Spawn-and-dispose bookkeeping (main, d453165/fee96a7): without this,
      // ephemeral agents leave checkpoint-tree keys and diagnostics map
      // entries behind for the life of the store/session.
      this.evictTurnCheckpoints(agent.name);
      // Turn-alive marker, same spawn-and-dispose logic: a stalled ephemeral
      // (watchdog fired, driveStream's terminal event lost) would strand its
      // token forever — no wedge (ephemeral names are unique per run) but
      // unbounded map growth. Blind delete is safe: the agent is already out
      // of the map, and a late driveStream finally token-match no-ops.
      this.activeTurnTokens.delete(agent.name);
    }
  }

  /**
   * Get queue depth.
   */
  getQueueDepth(): number {
    return this.queue.depth;
  }

  /**
   * Query inference logs.
   * Returns entries with summary info (doesn't resolve blobs).
   */
  /** Synthesized sleep/wake tool definitions (present when a gate is wired). */
  private static readonly SLEEP_TOOLS: import('./types/index.js').ToolDefinition[] = [
    {
      name: 'sleep',
      description:
        'Go quiet: suppress external pings and wakes for a number of seconds. ' +
        'Messages still accumulate in your context — you just won’t be woken to ' +
        'respond to them until the window passes. Your heartbeat still beats: you’ll ' +
        'briefly rouse on each tick and can keep resting or call `wake` to get up early. ' +
        'Privileged users can also still reach you. By default announces in your current channel.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'How long to stay asleep, in seconds.' },
          announce: {
            type: 'boolean',
            description: 'Announce the sleep in the current sticky channel (default true).',
          },
          message: {
            type: 'string',
            description: 'Optional custom announcement text (overrides the default).',
          },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'wake',
      description: 'End your current sleep early, resuming normal wakes immediately.',
      inputSchema: { type: 'object' },
    },
  ];

  /** Synthesized wake-rule tools: add/remove a gate.json policy at runtime.
   *  Present when a gate is wired. They write validated policies into the
   *  hot-reloaded gate.json (same validation as load), so a rule takes effect
   *  immediately and survives restart. */
  private static readonly WAKE_RULE_TOOLS: import('./types/index.js').ToolDefinition[] = [
    {
      name: 'wake_add_rule',
      description:
        'Add or replace a wake rule (a gate.json policy) at runtime — no need to ' +
        'hand-edit the file. The rule is validated and hot-applied immediately. ' +
        'A rule with the same `name` replaces the existing one in place (add a ' +
        'position to move it). ⚠️ ORDERING IS SEMANTICS: first match wins, and a ' +
        'matched rule CONSUMES the event — a broad rule placed early makes every ' +
        'later rule unreachable for its scope, including your addressed-message ' +
        '(DM/mention) wake rules. Prefer `insertBefore`/`insertAfter` to place a ' +
        'rule relative to a specific existing rule; use `position: "prepend"` only ' +
        'when the rule really must beat EVERYTHING. For "additionally wake me ' +
        'every Nth event / at most N per hour" governors, set `passthrough: true` ' +
        'so non-firing matches fall through to your normal rules instead of ' +
        'swallowing them. The result includes a before/after probe table and any ' +
        'shadow warnings — READ THEM before ending the turn. Two common shapes:\n' +
        '• Watch a FILE/workspace path: match on `mount` + `pathGlob`, e.g. ' +
        '`{ name: "watch-notes", match: { scope: ["workspace:modified"], mount: "project", pathGlob: "notes/*.md" }, behavior: "always" }`.\n' +
        '• Watch a CHANNEL: match on `source` + `channel` (and/or `tagsAny: ["chat:ambient"]`), ' +
        'e.g. `{ name: "watch-cairn", match: { source: "discord", channel: "discord:*:12345", tagsAny: ["chat:ambient"] }, behavior: { debounce: 60000 } }` ' +
        '(the channel must be subscribed for ambient events to arrive — see channel mode).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique rule name. Reusing a name replaces that rule.' },
          match: {
            type: 'object',
            description: 'Match criteria (all AND together). Omitted fields match anything.',
            properties: {
              scope: { type: 'array', items: { type: 'string' }, description: 'Event types, e.g. ["mcpl:channel-incoming","workspace:modified"].' },
              source: { type: 'string', description: 'Integration/serverId, glob ok (e.g. "discord").' },
              channel: { type: 'string', description: 'Channel id, glob ok (e.g. "discord:*:12345").' },
              mount: { type: 'string', description: 'Workspace mount name, glob ok (workspace:* events).' },
              pathGlob: { type: 'string', description: 'Glob over touched paths (workspace:* events).' },
              tagsAny: { type: 'array', items: { type: 'string' }, description: 'Match if ANY tag matches (globs ok).' },
              tagsAll: { type: 'array', items: { type: 'string' }, description: 'Match only if EVERY tag matches.' },
              tagsNone: { type: 'array', items: { type: 'string' }, description: 'Match only if NONE match.' },
              metadataTrue: { type: 'array', items: { type: 'string' }, description: 'Match if ANY listed metadata field is truthy.' },
              filter: {
                type: 'object',
                description: 'Content filter.',
                properties: {
                  type: { type: 'string', enum: ['text', 'regex'] },
                  pattern: { type: 'string' },
                },
                required: ['type', 'pattern'],
              },
            },
          },
          behavior: {
            type: 'string',
            enum: ['always', 'defer', 'skip'],
            description:
              'Simple behavior: "always" (wake now) or "defer" (don\'t wake; still enters ' +
              'context). For debounce / rate-limit / sampling, use debounceMs / rateLimit / ' +
              'passiveSample below instead of this field. Exactly one behavior must be given.',
          },
          debounceMs: {
            type: 'number',
            description: 'Shorthand for { debounce: ms }: wake once after ms of quiet (100–300000).',
          },
          rateLimit: {
            type: 'object',
            description: 'Token-bucket wake: at most `tokens` wakes per window; refills one per refillIntervalMs.',
            properties: {
              tokens: { type: 'number', description: 'Bucket capacity (> 0).' },
              refillIntervalMs: { type: 'number', description: 'Ms between token refills (> 0).' },
              keyBy: { type: 'string', description: 'Metadata field to partition buckets by (e.g. "channelId").' },
            },
            required: ['tokens', 'refillIntervalMs'],
          },
          passiveSample: {
            type: 'object',
            description: 'Wake every Nth matching event.',
            properties: {
              every: { type: 'number', description: 'Fire every N matches (positive integer).' },
              keyBy: { type: 'string', description: 'Metadata field for separate per-key counters.' },
            },
            required: ['every'],
          },
          position: {
            type: 'string',
            enum: ['append', 'prepend'],
            description:
              'Coarse placement. "append" (default) adds at the end; "prepend" puts the rule ' +
              'ahead of EVERYTHING — including addressed-message wake rules — so prefer ' +
              'insertBefore/insertAfter unless the rule really must beat every other rule. ' +
              'When replacing an existing name, giving any placement MOVES the rule there; ' +
              'omit all placement fields to update it in place.',
          },
          insertBefore: {
            type: 'string',
            description:
              'Insert the rule immediately BEFORE the named existing rule (error if absent). ' +
              'The safe way to order against a specific catch-all, e.g. insertBefore: "discord-ambient".',
          },
          insertAfter: {
            type: 'string',
            description: 'Insert the rule immediately AFTER the named existing rule (error if absent).',
          },
          passthrough: {
            type: 'boolean',
            description:
              'Observer semantics for rateLimit/passiveSample rules: when the rule matches but ' +
              'does not fire (below N, bucket empty), the event FALLS THROUGH to later rules ' +
              'instead of being consumed. Use for "additionally wake me every Nth event" ' +
              'governors so they never swallow DM/mention wakes.',
          },
          resets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of other rules whose runtime state to clear when this rule fires.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'wake_remove_rule',
      description:
        'Remove a wake rule (gate.json policy) by name at runtime. Any pending ' +
        'debounce batch for that rule is delivered first. Returns whether a rule ' +
        'was removed (false if no rule had that name).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The rule name to remove.' },
        },
        required: ['name'],
      },
    },
  ];

  /** Discoverability for event tags (MCPL RFC-001): the reserved chat:* core,
   *  each connected server's declared tag ontology, and gate.js status. */
  private static readonly EVENT_TAGS_TOOL: import('./types/index.js').ToolDefinition = {
    name: 'event_tags',
    description:
      'List the event tags available for gating: the reserved cross-platform ' +
      'chat:* core, each connected server\'s declared tag ontology (descriptions, ' +
      'implications, suggested treatments), and the status of your programmable ' +
      'gate (gate.js). Use these tag names in gate.json policies (tagsAny / ' +
      'tagsAll / tagsNone) or in gate.js.',
    inputSchema: { type: 'object' },
  };

  /** Synthesized save_image tool — present when a workspace module is
   *  registered. Lets the agent persist an image it has already seen in its
   *  own context (Discord attachments arrive inlined as base64 and are
   *  otherwise unreachable as files). */
  private static readonly SAVE_IMAGE_TOOL: import('./types/index.js').ToolDefinition = {
    name: 'save_recent_image',
    description:
      'Save one or more recent images from your own context to workspace files. ' +
      'Images are counted back from the most recent (index 0). A single image is ' +
      'written to `path` as given (e.g. "project/photos/cat.png"); when `count` > 1 ' +
      'the range index..index+count-1 is saved with numeric suffixes ' +
      '("cat-0.png", "cat-1.png", …; 0 = the newest of the range). Saved files are ' +
      'visible via workspace tools and the /files/ endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Mount-prefixed destination path, e.g. "project/photos/name.png".',
        },
        index: {
          type: 'number',
          description: 'Which image, counting back from the most recent (0 = most recent). Default 0.',
        },
        count: {
          type: 'number',
          description: 'How many images to save, starting at `index` and going further back. Default 1.',
        },
      },
      required: ['path'],
    },
  };

  /** Synthesized read_image tool — present when a workspace module is
   *  registered. Returns the image as a native image block in the tool
   *  result, so the agent SEES it in the live turn (history keeps a compact
   *  placeholder via the standard tool-result serializer). */
  private static readonly READ_IMAGE_TOOL: import('./types/index.js').ToolDefinition = {
    name: 'read_image',
    description:
      'View an image file from a workspace mount. The image is returned into ' +
      'your context so you can actually see it (e.g. after save_recent_image, ' +
      'or for images placed in the workspace by other means). Path is ' +
      'mount-prefixed, e.g. "project/photos/cat.png". Supports png/jpeg/gif/webp.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Mount-prefixed image path, e.g. "project/photos/name.png".',
        },
      },
      required: ['path'],
    },
  };

  private static readonly AGENT_SETTINGS_TOOL: import('./types/index.js').ToolDefinition = {
    name: 'agent_settings',
    description:
      'Read or change your hot runtime settings. This intentionally exposes only ' +
      'context budget, recent raw tail size, transition pace, and same-round think text routing; model, prompts, ' +
      'folding strategy, and other restart-bound configuration are not mutable here. ' +
      'Lower context budgets converge gradually under the transition pace before ' +
      'becoming the hard live limit; increases take effect immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update', 'reset', 'cancel'] },
        context_budget_tokens: { type: 'number', description: 'Total input context budget, including the reserved response allowance.' },
        tail_tokens: { type: 'number', description: 'Recent raw context retained verbatim.' },
        transition_pace_tokens: { type: 'number', description: 'Maximum ordinary KV re-read/perturbation per compile while converging.' },
        immediate: {
          type: 'boolean',
          description:
            'With a context_budget_tokens DECREASE: apply it immediately instead of a paced descent — ' +
            'the whole fold-down and its KV re-read land on the next compile, and any in-flight descent is cancelled.',
        },
        same_round_think_text_policy: {
          type: 'string',
          enum: ['public', 'private'],
          description:
            'Routing policy for ordinary text emitted in the same native assistant round as think(). ' +
            "Omitted in the recipe preserves the compatibility carry-forward: public.",
        },
        settings: {
          type: 'array',
          items: { type: 'string', enum: ['context_budget_tokens', 'tail_tokens', 'transition_pace_tokens', 'same_round_think_text_policy'] },
          description: 'For reset: settings to restore to recipe values. Omit to reset all.',
        },
      },
      required: ['action'],
    },
  };

  /** Reserved chat:* core vocabulary (MCPL RFC-001 §4) — short descriptions so
   *  the agent can author rules without reading the spec. */
  private static readonly CHAT_CORE_TAGS: Record<string, string> = {
    'chat:addressed': 'Directed at you (umbrella: dm/mention/reply)',
    'chat:mention': 'You were explicitly @-mentioned',
    'chat:reply': 'A reply to your own message',
    'chat:dm': 'A direct/private message to you',
    'chat:ambient': 'Overheard in a followed channel; not addressed',
    'chat:broadcast': 'Channel-wide ping (@everyone / channel post)',
    'chat:to-self': 'Acts on your own content (reaction/reply to you)',
    'chat:from-human': 'Authored by a human',
    'chat:from-bot': 'Authored by a bot/automation',
    'chat:from-self': 'Your own message, echoed back',
    'chat:from-agent': 'Authored by another persona/agent',
    'chat:edited': 'An edit of an existing message',
    'chat:deleted': 'A deletion',
    'chat:reaction': 'An emoji reaction was added',
    'chat:reaction-remove': 'A reaction was removed',
    'chat:has-image': 'Has an image attachment',
    'chat:has-audio': 'Has an audio attachment',
    'chat:has-file': 'Has a file attachment',
    'chat:has-link': 'Contains a link',
    'chat:command': 'A slash/bot command invocation',
    'chat:private': 'Private conversation',
    'chat:group': 'Group (multi-party) conversation',
    'chat:thread': 'Occurred in a thread',
  };

  /**
   * Mark an inference refusal visibly: react on the message that holds the
   * conversational locus (the most recent incoming channel message) with a
   * category-specific emoji. Best-effort — failures are logged, never thrown,
   * and non-Discord loci are silently skipped.
   */
  private async reactToRefusal(agentName: string, category: string): Promise<void> {
    try {
      const incoming = this.channelRegistry?.buildChannelContext()?.incoming;
      if (!incoming) return;
      // incoming.channelId is the MCPL composite id ("discord:<guild>:<channel>");
      // the reaction tool wants the raw Discord channel (or thread) id — the
      // last segment.
      const parts = incoming.channelId.split(':');
      if (parts[0] !== 'discord') return;
      const channelId = parts[parts.length - 1];
      const emoji = REFUSAL_REACTIONS[category] ?? REFUSAL_REACTION_FALLBACK;
      // Resolve the MCPL server that owns the locus channel and call
      // tools/call directly on its connection (bare tool name — no prefix
      // games), bypassing the agent event queue so no synthetic tool-result
      // is injected into a turn the agent never took.
      const serverId = this.channelRegistry?.getChannelServerId(incoming.channelId);
      const server = serverId ? this.mcplServerRegistry?.getServer(serverId) : null;
      if (!server) {
        console.error(
          `[inference-refusal] reaction skipped: no MCPL server for locus "${incoming.channelId}" (agent=${agentName})`,
        );
        return;
      }
      await server.sendToolsCall('add_reaction', {
        channelId,
        messageId: incoming.messageId,
        emoji,
      });
    } catch (err) {
      console.error(
        '[inference-refusal] reaction failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Rewind the single turn that fed a refused generation: redact the newest
   * message the agent did NOT author (a tool result, or an incoming message)
   * and inject a metadata-only marker in its place. The marker carries a
   * *description* of what was withheld (kind + size), never the content — so it
   * cannot itself re-trip the classifier — while the raw record survives in the
   * chronicle log for forensics. Returns a record describing the removal, or
   * null if there is nothing eligible to rewind (e.g. only the agent's own
   * turns, or a prior system marker, remain).
   *
   * Shared by the auto path (on `stop_reason: refusal`) and the `/rewind`
   * host command.
   */
  private shedNewestTurn(agent: Agent): RewindRecord | null {
    const cm = agent.getContextManager();
    const all = cm.getAllMessages();
    const typeOf = (b: unknown) => (b as { type?: string }).type;
    const hasBlock = (m: { content?: unknown } | undefined, t: string) =>
      Array.isArray(m?.content) && (m!.content as unknown[]).some((b) => typeOf(b) === t);

    // Newest message that is not our own episode marker. We shed strictly
    // newest-first, in sequence — INCLUDING the agent's own turns (poison lives
    // in tool_use/narration turns too), because newest-first reaches whatever is
    // poisoning the context if allowed to run deep enough. The one invariant:
    // shed COMPLETE exchanges. Removing a `tool_result` also removes its paired
    // `tool_use` assistant turn, so we never leave an orphaned tool_use / signed
    // `thinking` block — which the API rejects with a 400 ("thinking blocks in
    // the latest assistant message cannot be modified"). We do NOT add a marker
    // here; the caller keeps one consolidated marker (updateRewindMarker).
    let idx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      const meta = (all[i].metadata ?? {}) as { system?: unknown };
      if (meta.system) continue;
      idx = i; break;
    }
    if (idx < 0) return null;
    const msg = all[idx];
    const md = (msg.metadata ?? {}) as {
      messageId?: unknown; channelId?: unknown; system?: unknown;
    };

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolBlocks = content.filter((b) => typeOf(b) === 'tool_result');
    const images = content.filter((b) => typeOf(b) === 'image').length;
    const textLen = content
      .filter((b) => typeOf(b) === 'text')
      .reduce((n, b) => n + String((b as { text?: string }).text ?? '').length, 0);

    // Determine the complete exchange to remove.
    const removedIds: MessageId[] = [msg.id];
    let kind: RewindRecord['kind'];
    let descriptor: string;
    if (toolBlocks.length > 0) {
      kind = 'tool';
      // Pair the tool_result with the tool_use assistant turn right before it.
      if (idx - 1 >= 0 && hasBlock(all[idx - 1], 'tool_use')) {
        removedIds.push(all[idx - 1].id);
      }
      const sz = toolBlocks.reduce(
        (n, b) => n + String((b as { content?: unknown }).content ?? '').length, 0);
      descriptor = `a tool exchange (~${Math.max(1, Math.round(sz / 1024))}KB` +
        `${images ? `, ${images} image(s)` : ''})`;
    } else if (md.messageId) {
      kind = 'human';
      descriptor = `an incoming message from ${msg.participant} ` +
        `(${textLen} chars${images ? `, ${images} image(s)` : ''})`;
    } else {
      kind = 'other';
      descriptor = `a ${msg.participant} turn ` +
        `(${textLen} chars${images ? `, ${images} image(s)` : ''})`;
    }
    const discordRef = md.messageId && md.channelId
      ? { channelId: String(md.channelId), messageId: String(md.messageId) }
      : undefined;

    for (const id of removedIds) cm.removeMessage(id);
    return { kind, descriptor, removedIds, discordRef };
  }

  /**
   * Maintain exactly ONE consolidated marker for the current rewind episode,
   * updated in place as more turns are shed. Six rewinds ⇒ one message that
   * says "the 6 most recent turns were set aside", not six separate notes — so
   * the context converges (shed N, add 1) instead of growing, and the marker
   * sits at the tail giving the model something actionable to answer once the
   * refusal clears. Returns the running count.
   */
  private updateRewindMarker(
    agent: Agent,
    category: string,
    cause: 'refusal' | 'inference-failure' = 'refusal',
  ): number {
    const cm = agent.getContextManager();
    const ep = this.rewindEpisode.get(agent.name);
    const count = (ep?.count ?? 0) + 1;
    const why = cause === 'refusal'
      ? `the model refused on them (content filter: ${category}). Their content is ` +
        `not reproduced here (so this note can't re-trigger the filter); the ` +
        `originals remain in the raw record`
      : `the model API kept rejecting the conversation on them (${category}). ` +
        `Their content is not reproduced here (so this note can't re-trigger the ` +
        `rejection); the originals remain in the raw record`;
    const text =
      `[refusal-rewind] The ${count} most recent turn(s) were set aside because ` +
      `${why}. You are clear to continue — if you ` +
      `were mid-task, take a different approach; otherwise carry on with whatever ` +
      `is now in front of you, or briefly acknowledge the gap and ask what's next.`;
    const blocks: ContentBlock[] = [{ type: 'text', text }];
    if (ep) {
      cm.editMessage(ep.markerId, blocks);
      this.rewindEpisode.set(agent.name, { markerId: ep.markerId, count, category });
    } else {
      const id = cm.addMessage('user', blocks, {
        system: true, kind: 'refusal-rewind', category, count, cause,
      });
      this.rewindEpisode.set(agent.name, { markerId: id, count, category });
    }
    return count;
  }

  /**
   * Announce a refusal-rewind on the conversational surface (Discord), used
   * when the withheld turn was a *human* message so it isn't dropped silently.
   * Best-effort; mirrors reactToRefusal's locus resolution.
   */
  private async announceRewind(
    agentName: string,
    rec: RewindRecord,
    category: string,
  ): Promise<void> {
    try {
      const incoming = this.channelRegistry?.buildChannelContext()?.incoming;
      if (!incoming) return;
      const parts = incoming.channelId.split(':');
      if (parts[0] !== 'discord') return;
      const channelId = parts[parts.length - 1];
      const serverId = this.channelRegistry?.getChannelServerId(incoming.channelId);
      const server = serverId ? this.mcplServerRegistry?.getServer(serverId) : null;
      if (!server) return;
      await server.sendToolsCall('send_message', {
        channelId,
        content:
          `⚠️ I had to set aside ${rec.descriptor} — it tripped a content ` +
          `filter (${category}), so it's withheld from my context and I'm ` +
          `continuing without it. If it was important, please rephrase or re-send.`,
      });
    } catch (err) {
      console.error(
        '[refusal-rewind] announce failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Conclude an active `/unstick` session: post the outcome (what was shed and
   * whether the model stopped refusing) to the channel the command came from,
   * then clear the session. Idempotent — a no-op if there's no session.
   */
  private finishUnstick(agentName: string, success: boolean, category?: string): void {
    const s = this.forcedRewind.get(agentName);
    if (!s) return;
    this.forcedRewind.delete(agentName);
    const n = s.removed.length;
    const list = n
      ? '\n' + s.removed.map((r) => `• ${r.descriptor}`).join('\n')
      : '';
    const content = success
      ? `🔧 Unstuck **${agentName}** — shed ${n} turn(s); the model responded.${list}`
      : `⚠️ Couldn't unstick **${agentName}** — still refusing after ${n} rewind(s)` +
        `${category ? ` (category=${category})` : ''}.${list}`;
    console.error(
      `[unstick] agent=${agentName} ${success ? 'succeeded' : 'gave up'} after ${n} rewind(s)`,
    );
    if (s.channelId) void this.postToChannel(s.serverId, s.channelId, content);
  }

  /** Best-effort send_message to a raw channel via a named MCPL server. */
  private async postToChannel(serverId: string, channelId: string, content: string): Promise<void> {
    try {
      const server = this.mcplServerRegistry?.getServer(serverId);
      if (!server) return;
      await server.sendToolsCall('send_message', { channelId, content });
    } catch (err) {
      console.error('[unstick] report post failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Admin-level nudge: run an inference turn on the agent's CURRENT context
   * without adding any message, event, or other context mutation. The turn
   * compiles exactly what the agent already sees — useful after an /undo,
   * a /hide, or whenever an operator wants the agent to take another look
   * (or another swing) at where it stands, with zero context pollution.
   *
   * Queues a normal inference request (same path as gate wakes): if the
   * agent is mid-turn it runs when the turn settles; a pending skip_reply
   * self-wake is superseded like any other wake. Deliberately NOT gated on
   * idle — "run when you're free" is the useful semantic. No suppression
   * interplay: gate sleep filters events, not queued requests, so a nudge
   * wakes even a sleeping agent (it's an admin override, like /unstick).
   */
  nudgeAgent(agentName?: string, requestedBy?: string): {
    ok: boolean;
    error?: string;
    agentName?: string;
    /** Agent state at queue time — 'idle' means the turn starts on the next
     *  scheduler pass; anything else means it runs after the current turn. */
    agentStatus?: string;
  } {
    const name = agentName ?? [...this.agents.keys()][0];
    const agent = name ? this.agents.get(name) : undefined;
    if (!name || !agent) {
      return { ok: false, error: `Unknown agent: ${String(agentName ?? '(none registered)')}` };
    }
    const agentStatus = this.activeTurnTokens.has(name) && agent.state.status === 'idle'
      ? 'idle+turn-alive'
      : agent.state.status;
    this.pendingRequests.push({
      agentName: name,
      reason: requestedBy ? `admin-nudge (${requestedBy})` : 'admin-nudge',
      source: 'admin',
      timestamp: Date.now(),
    });
    console.error(`[nudge] agent=${name} queued by=${requestedBy ?? 'unknown'} status=${agentStatus}`);
    return { ok: true, agentName: name, agentStatus };
  }

  /**
   * Handle a `host/command` request from an MCPL surface server (e.g. a
   * Discord slash command). Currently supports:
   *
   *   undo — revert the last N inference turns (branch-based, see
   *   `undoLastTurn`). The response includes the last message the agent
   *   would see in its context after the undo, obtained via the transparent
   *   `previewActivation` render (no inference, no Chronicle writes).
   *
   *   nudge — run inference on the current context with NO new events
   *   (see `nudgeAgent`).
   */
  private async handleHostCommand(
    serverId: string,
    params: HostCommandParams,
  ): Promise<{
    ok: boolean;
    error?: string;
    undone?: number;
    requested?: number;
    messagesRemoved?: number;
    /** Discord addresses removed by message-granular undo. The durable outbox
     *  owns eventual delivery; this is also returned for immediate surfaces. */
    removedRefs?: Array<{ serverId: string; channelId: string; messageId: string }>;
    hidden?: number;
    /** For `hide`: the Discord (channelId, messageId) of each removed message
     *  that carried one — so the surface can mark them with a reaction. */
    hiddenRefs?: Array<{ channelId: string; messageId: string }>;
    lastVisible?: { participant?: string; role?: string; preview?: string } | null;
    /** For `unstick`: acknowledges the forced-rewind loop has started; the
     *  outcome report is posted to the channel asynchronously. */
    started?: boolean;
    cap?: number;
    /** For `nudge`: agent state at queue time ('idle' = runs immediately,
     *  else it runs once the current turn settles). */
    agentStatus?: string;
  }> {
    if (
      params.command !== 'undo' &&
      params.command !== 'hide' &&
      params.command !== 'unstick' &&
      params.command !== 'nudge'
    ) {
      return { ok: false, error: `Unknown host command: ${String(params.command)}` };
    }

    const agentName = params.agentName ?? [...this.agents.keys()][0];
    if (!agentName || !this.agents.has(agentName)) {
      return { ok: false, error: `Unknown agent: ${String(agentName)}` };
    }

    // nudge: queue an inference on the current context — no message, no
    // event, no context mutation (see nudgeAgent).
    if (params.command === 'nudge') {
      const r = this.nudgeAgent(
        agentName,
        params.requesterName ?? params.requesterId ?? `mcpl:${serverId}`,
      );
      return { ok: r.ok, error: r.error, agentStatus: r.agentStatus };
    }

    // unstick: force the refusal-rewind loop on demand (even if the agent's
    // autoRewind toggle is off). Redacts the turn that fed the refusal and
    // re-runs, up to `cap` times, until the model stops refusing. Kicks the
    // loop and returns immediately; the outcome (what was shed + whether it
    // cleared) is posted to the channel when the chain resolves.
    if (params.command === 'unstick') {
      const agent = this.agents.get(agentName)!;
      if (agent.state.status !== 'idle') {
        return { ok: false, error: `Cannot unstick while agent is ${agent.state.status}` };
      }
      const cap = Math.max(1, Math.min(10,
        Math.floor(params.maxRewinds ?? agent.refusalHandling?.maxRewinds ?? 3)));
      this.forcedRewind.set(agentName, {
        remaining: cap,
        removed: [],
        serverId,
        channelId: params.channelId ?? '',
      });
      this.refusalRewinds.set(agentName, 0);
      this.pendingRequests.push({
        agentName,
        reason: 'unstick',
        source: 'framework',
        timestamp: Date.now(),
      });
      console.error(
        `[unstick] agent=${agentName} started cap=${cap} ` +
          `by=${params.requesterName ?? params.requesterId ?? 'unknown'} (server=${serverId})`,
      );
      return { ok: true, started: true, cap };
    }

    // hide: redact a single message (or an inclusive range) from the active
    // branch, addressed by Discord message id. Unlike undo this is a
    // removal-in-place (chronicle redact), not a branch rewind.
    if (params.command === 'hide') {
      const agent = this.agents.get(agentName)!;
      if (agent.state.status !== 'idle') {
        return { ok: false, error: `Cannot hide while agent is ${agent.state.status}` };
      }
      if (!params.fromMessageId) {
        return { ok: false, error: 'hide: fromMessageId is required' };
      }
      const cm = agent.getContextManager();
      const all = cm.getAllMessages();
      const byDiscordId = (did: string) =>
        all.findIndex((m) => String((m.metadata as { messageId?: unknown } | undefined)?.messageId) === String(did));

      // Collect Discord refs of every message in [lo, hi] that carries one,
      // so the surface can mark them. channelId here is whatever the ingest
      // path stored (raw id or "discord:guild:channel"); the surface
      // normalizes it.
      const refsIn = (lo: number, hi: number) => {
        const refs: Array<{ channelId: string; messageId: string }> = [];
        for (let i = lo; i <= hi; i++) {
          const md = all[i].metadata as { messageId?: unknown; channelId?: unknown } | undefined;
          if (md?.messageId && md?.channelId) {
            refs.push({ channelId: String(md.channelId), messageId: String(md.messageId) });
          }
        }
        return refs;
      };

      const fromIdx = byDiscordId(params.fromMessageId);
      if (fromIdx < 0) {
        return {
          ok: false,
          error: `Message ${params.fromMessageId} is not an addressable message in context (it may only exist inside backscroll text, or predates this session).`,
        };
      }

      try {
        if (params.toMessageId) {
          const toIdx = byDiscordId(params.toMessageId);
          if (toIdx < 0) {
            return { ok: false, error: `Message ${params.toMessageId} is not an addressable message in context.` };
          }
          const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
          const refs = refsIn(lo, hi);
          cm.removeMessages(all[lo].id, all[hi].id);
          console.error(
            `[host-command] hide agent=${agentName} range removed=${hi - lo + 1} ` +
              `(${params.fromMessageId}..${params.toMessageId}) by=${params.requesterName ?? params.requesterId ?? 'unknown'} (server=${serverId})`,
          );
          return {
            ok: true,
            hidden: hi - lo + 1,
            hiddenRefs: refs,
            lastVisible: await this.lastVisiblePreview(agentName),
          };
        }
        const refs = refsIn(fromIdx, fromIdx);
        cm.removeMessage(all[fromIdx].id);
        console.error(
          `[host-command] hide agent=${agentName} removed=1 (${params.fromMessageId}) ` +
            `by=${params.requesterName ?? params.requesterId ?? 'unknown'} (server=${serverId})`,
        );
        return {
          ok: true,
          hidden: 1,
          hiddenRefs: refs,
          lastVisible: await this.lastVisiblePreview(agentName),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // Message-granular mode: branch the chronicle at the message that should
    // become the new tail (ContextManager.branchAt — origin-sequence-based
    // time-travel branching; see chronicle's rfc-state-item-origins addendum).
    // No turn checkpoints involved, so this reaches past turn boundaries.
    if (typeof params.messages === 'number' && params.messages > 0) {
      const agent = this.agents.get(agentName)!;
      if (agent.state.status !== 'idle') {
        return { ok: false, error: `Cannot undo while agent is ${agent.state.status}` };
      }
      const n = Math.max(1, Math.min(50, Math.floor(params.messages)));
      const cm = agent.getContextManager();
      const allMessages = cm.getAllMessages();
      if (n >= allMessages.length) {
        return {
          ok: false,
          error: `Cannot remove ${n} message(s) — history has ${allMessages.length}; at least one must remain.`,
        };
      }
      const target = allMessages[allMessages.length - 1 - n];
      const discarded = allMessages.slice(allMessages.length - n);
      const removedRefs = extractDiscordAwarenessRefs(discarded);
      const sourceBranch = this.store.currentBranch().name;
      const targetBranch = `undo-msgs/${agentName}/${Date.now()}`;

      // Prepare the external side effect before switching Chronicle. If the
      // process dies after the switch but before activate(), startup promotes
      // this batch by matching targetBranch to the active branch.
      const markerBatch = this.discordAwarenessOutbox?.prepare({
        agentName,
        sourceBranch,
        targetBranch,
        refs: removedRefs,
        emoji: this.discordAwarenessEmoji,
      }) ?? null;

      const branchName = cm.branchAt(target.id, targetBranch);
      await cm.switchBranch(branchName);
      if (markerBatch) this.discordAwarenessOutbox!.activate(markerBatch.id);
      await this.syncDiscordAwarenessMarkers();

      // Materialize config files from the new branch (fire-and-forget; gate
      // picks up via mtime) — mirrors undoLastTurn.
      const wsUndo = this.moduleRegistry.getModule('workspace');
      if (wsUndo && 'materializeMount' in wsUndo) {
        (wsUndo as { materializeMount: (m: string) => Promise<void> })
          .materializeMount('_config')
          .catch(() => {});
      }

      console.error(
        `[host-command] undo-messages agent=${agentName} removed=${n} branch=${branchName}` +
          ` by=${params.requesterName ?? params.requesterId ?? 'unknown'} (server=${serverId})`,
      );

      return {
        ok: true,
        messagesRemoved: n,
        removedRefs,
        lastVisible: await this.lastVisiblePreview(agentName),
      };
    }

    const requested = Math.max(1, Math.min(20, Math.floor(params.turns ?? 1)));
    let undone = 0;
    try {
      for (let i = 0; i < requested; i++) {
        const r = this.undoLastTurn(agentName);
        if (!r.undone) break;
        undone++;
      }
    } catch (error) {
      // e.g. "Cannot undo while agent is streaming" — report what happened,
      // including any turns already undone before the failure.
      const msg = error instanceof Error ? error.message : String(error);
      if (undone === 0) return { ok: false, error: msg };
      console.error(`[host-command] undo partially failed after ${undone}/${requested}: ${msg}`);
    }

    console.error(
      `[host-command] undo agent=${agentName} requested=${requested} undone=${undone}` +
        ` by=${params.requesterName ?? params.requesterId ?? 'unknown'} (server=${serverId})`,
    );

    if (undone === 0) {
      return { ok: true, undone: 0, requested, lastVisible: null };
    }

    await this.syncDiscordAwarenessMarkers();

    return { ok: true, undone, requested, lastVisible: await this.lastVisiblePreview(agentName) };
  }

  /**
   * The last message the agent would see in its context right now, via the
   * transparent `previewActivation` render (no inference, no Chronicle
   * writes). Returns null if the preview fails or the context is empty.
   */
  private async lastVisiblePreview(
    agentName: string,
  ): Promise<{ participant?: string; role?: string; preview?: string } | null> {
    try {
      const preview = await this.previewActivation(agentName);
      const messages = (preview as { messages?: unknown[] }).messages ?? [];
      const last = messages[messages.length - 1] as
        | { role?: string; participant?: string; content?: unknown }
        | undefined;
      if (!last) return null;
      const blocks = Array.isArray(last.content) ? last.content : [];
      const text = blocks
        .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
        .join(' ')
        .trim();
      // Surface-injected preambles (<system>…</system>, <backscroll>…
      // </backscroll>) can dominate the head of a bundled incoming message
      // and bury the actual conversational line. Strip them for the
      // preview; fall back to the raw text if nothing else remains.
      const stripped = text
        .replace(/<system>[\s\S]*?<\/system>/g, '')
        .replace(/<backscroll\b[\s\S]*?<\/backscroll>/g, '')
        .trim();
      const body = stripped.length > 0 ? stripped : text;
      return {
        participant: last.participant,
        role: last.role,
        preview: body.length > 400 ? `${body.slice(0, 400)}…` : body,
      };
    } catch (error) {
      console.error(
        '[host-command] post-undo context preview failed:',
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  queryInferenceLogs(query?: InferenceLogQuery): InferenceLogQueryResult {
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const pattern = query?.pattern ? new RegExp(query.pattern, 'i') : null;

    // Get all entries from the append log
    const allEntries: InferenceLogEntryWithId[] = [];
    const stateInfo = this.store.listStates().find((s) => s.id === INFERENCE_LOG_ID);

    if (stateInfo) {
      // Query the append log - get raw data
      const data = this.store.getStateJson(INFERENCE_LOG_ID);
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const entry = data[i] as InferenceLogEntry;

          // Build summary (without resolving blobs)
          const requestIsBlob = !!(entry.request && typeof entry.request === 'object' && 'blobId' in entry.request);
          const responseIsBlob = !!(entry.response && typeof entry.response === 'object' && 'blobId' in entry.response);

          const summary: InferenceLogSummary = {
            timestamp: entry.timestamp,
            agentName: entry.agentName,
            requestId: entry.requestId,
            success: entry.success,
            error: entry.error,
            durationMs: entry.durationMs,
            tokenUsage: entry.tokenUsage,
            stopReason: entry.stopReason,
            requestIsBlob,
            responseIsBlob,
          };

          allEntries.push({ sequence: i, entry, summary });
        }
      }
    }

    // Filter entries
    let filtered = allEntries;

    if (query?.agentName) {
      filtered = filtered.filter((e) => e.entry.agentName === query.agentName);
    }

    if (query?.errorsOnly) {
      filtered = filtered.filter((e) => !e.entry.success);
    }

    if (pattern) {
      filtered = filtered.filter((e) => {
        // Search in summary fields only (not blob content)
        const content = JSON.stringify(e.summary);
        return pattern.test(content);
      });
    }

    // Reverse to get most recent first
    filtered = filtered.reverse();

    // Paginate
    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return {
      entries: paged,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a specific inference log entry by sequence number.
   * Resolves blob references to full content.
   */
  getInferenceLog(sequence: number, resolveBlobs = true): InferenceLogEntryWithId | null {
    const data = this.store.getStateJson(INFERENCE_LOG_ID);
    if (Array.isArray(data) && sequence >= 0 && sequence < data.length) {
      const entry = data[sequence] as InferenceLogEntry;

      if (resolveBlobs) {
        // Resolve blob references
        const resolved = { ...entry };

        if (entry.request && typeof entry.request === 'object' && 'blobId' in entry.request) {
          const blob = this.store.getBlob((entry.request as { blobId: string }).blobId);
          if (blob) {
            try {
              resolved.request = JSON.parse(blob.toString());
            } catch {
              resolved.request = { error: 'Failed to parse blob', blobId: (entry.request as { blobId: string }).blobId };
            }
          }
        }

        if (entry.response && typeof entry.response === 'object' && 'blobId' in entry.response) {
          const blob = this.store.getBlob((entry.response as { blobId: string }).blobId);
          if (blob) {
            try {
              resolved.response = JSON.parse(blob.toString());
            } catch {
              resolved.response = { error: 'Failed to parse blob', blobId: (entry.response as { blobId: string }).blobId };
            }
          }
        }

        return { sequence, entry: resolved };
      }

      return { sequence, entry };
    }
    return null;
  }

  /**
   * Get the most recent inference logs (tail).
   */
  tailInferenceLogs(count = 10, agentName?: string): InferenceLogEntryWithId[] {
    const result = this.queryInferenceLogs({
      limit: count,
      agentName,
    });
    return result.entries;
  }

  /**
   * Query process logs.
   * Returns entries with summary info (doesn't resolve blobs).
   */
  queryProcessLogs(query?: ProcessLogQuery): ProcessLogQueryResult {
    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;
    const pattern = query?.pattern ? new RegExp(query.pattern, 'i') : null;

    const allEntries: ProcessLogEntryWithId[] = [];
    const stateInfo = this.store.listStates().find((s) => s.id === PROCESS_LOG_ID);

    if (stateInfo) {
      const data = this.store.getStateJson(PROCESS_LOG_ID);
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const entry = data[i] as ProcessLogEntry;

          // Build summary
          const responsesIsBlob = !!(
            entry.responses &&
            typeof entry.responses === 'object' &&
            'blobId' in entry.responses
          );

          // Extract summary info from responses if not a blob
          let moduleCount = 0;
          const modulesRequestingInference: string[] = [];
          const modulesAddingMessages: string[] = [];

          if (!responsesIsBlob && Array.isArray(entry.responses)) {
            moduleCount = entry.responses.length;
            for (const { moduleName, response } of entry.responses) {
              if (response.requestInference) {
                modulesRequestingInference.push(moduleName);
              }
              if (response.addMessages?.length) {
                modulesAddingMessages.push(moduleName);
              }
            }
          }

          const summary: ProcessLogSummary = {
            timestamp: entry.timestamp,
            eventType: entry.processEvent.type,
            moduleCount,
            modulesRequestingInference,
            modulesAddingMessages,
            responsesIsBlob,
          };

          allEntries.push({ sequence: i, entry, summary });
        }
      }
    }

    // Filter entries
    let filtered = allEntries;

    if (query?.eventType) {
      filtered = filtered.filter((e) => e.entry.processEvent.type === query.eventType);
    }

    if (query?.moduleName) {
      filtered = filtered.filter((e) => {
        if (e.summary?.responsesIsBlob) return false;
        const responses = e.entry.responses as ModuleProcessResponse[];
        return responses.some((r) => r.moduleName === query.moduleName);
      });
    }

    if (pattern) {
      filtered = filtered.filter((e) => {
        const content = JSON.stringify(e.summary);
        return pattern.test(content);
      });
    }

    // Reverse to get most recent first
    filtered = filtered.reverse();

    // Paginate
    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return {
      entries: paged,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a specific process log entry by sequence number.
   * Resolves blob references to full content.
   */
  getProcessLog(sequence: number, resolveBlobs = true): ProcessLogEntryWithId | null {
    const data = this.store.getStateJson(PROCESS_LOG_ID);
    if (Array.isArray(data) && sequence >= 0 && sequence < data.length) {
      const entry = data[sequence] as ProcessLogEntry;

      if (resolveBlobs && entry.responses && typeof entry.responses === 'object' && 'blobId' in entry.responses) {
        const resolved = { ...entry };
        const blob = this.store.getBlob((entry.responses as { blobId: string }).blobId);
        if (blob) {
          try {
            resolved.responses = JSON.parse(blob.toString());
          } catch {
            resolved.responses = [];
          }
        }
        return { sequence, entry: resolved };
      }

      return { sequence, entry };
    }
    return null;
  }

  /**
   * Get the most recent process logs (tail).
   */
  tailProcessLogs(count = 10, eventType?: string): ProcessLogEntryWithId[] {
    const result = this.queryProcessLogs({
      limit: count,
      eventType,
    });
    return result.entries;
  }

  // ==========================================================================
  // Undo / Redo
  // ==========================================================================

  /**
   * Undo the last inference turn for an agent.
   *
   * Creates a new branch at the Chronicle sequence recorded before that turn
   * and switches to it, atomically rolling back all state (messages, context
   * log, inference log, MCPL checkpoints).
   *
   * The undone branch is saved so `redo()` can restore it.
   * Returns the checkpoint that was undone, or null if nothing to undo.
   */
  undoLastTurn(agentName: string): {
    undone: boolean;
    turnIndex?: number;
    fromBranch?: string;
    toBranch?: string;
  } {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    if (agent.state.status !== 'idle') {
      throw new Error(`Cannot undo while agent is ${agent.state.status}`);
    }

    const checkpoints = this.getTurnCheckpoints(agentName);
    if (checkpoints.length === 0) {
      return { undone: false };
    }

    const checkpoint = checkpoints.pop()!;
    this.saveTurnCheckpoints(agentName, checkpoints);

    const currentBranch = this.store.currentBranch();
    const undoBranchName = `undo/${agentName}/${checkpoint.turnIndex}-${Date.now()}`;

    this.store.createBranchAt(undoBranchName, currentBranch.name, checkpoint.sequenceBefore);
    this.store.switchBranch(undoBranchName);

    // Materialize config files from the new branch (fire-and-forget; gate picks up via mtime)
    const wsUndo = this.moduleRegistry.getModule('workspace');
    if (wsUndo && 'materializeMount' in wsUndo) {
      (wsUndo as any).materializeMount('_config').catch(() => {});
    }

    // Push onto redo stack
    let redoStack = this.redoStacks.get(agentName);
    if (!redoStack) {
      redoStack = [];
      this.redoStacks.set(agentName, redoStack);
    }
    redoStack.push({ branchName: currentBranch.name, checkpoint });

    this.emitTrace({
      type: 'undo:completed',
      agentName,
      turnIndex: checkpoint.turnIndex,
      fromBranch: currentBranch.name,
      toBranch: undoBranchName,
    });

    return {
      undone: true,
      turnIndex: checkpoint.turnIndex,
      fromBranch: currentBranch.name,
      toBranch: undoBranchName,
    };
  }

  /**
   * Redo a previously undone turn for an agent.
   *
   * Switches back to the branch that was active before the last undo.
   * Returns false if there's nothing to redo.
   */
  redo(agentName: string): {
    redone: boolean;
    fromBranch?: string;
    toBranch?: string;
  } {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentName}`);
    }
    if (agent.state.status !== 'idle') {
      throw new Error(`Cannot redo while agent is ${agent.state.status}`);
    }

    const redoStack = this.redoStacks.get(agentName);
    if (!redoStack || redoStack.length === 0) {
      return { redone: false };
    }

    const { branchName, checkpoint } = redoStack.pop()!;
    const currentBranch = this.store.currentBranch();

    this.store.switchBranch(branchName);

    // Materialize config files from the restored branch (fire-and-forget; gate picks up via mtime)
    const wsRedo = this.moduleRegistry.getModule('workspace');
    if (wsRedo && 'materializeMount' in wsRedo) {
      (wsRedo as any).materializeMount('_config').catch(() => {});
    }

    // Restore the checkpoint
    const checkpoints = this.getTurnCheckpoints(agentName);
    checkpoints.push(checkpoint);
    this.saveTurnCheckpoints(agentName, checkpoints);

    this.emitTrace({
      type: 'redo:completed',
      agentName,
      fromBranch: currentBranch.name,
      toBranch: branchName,
    });

    return {
      redone: true,
      fromBranch: currentBranch.name,
      toBranch: branchName,
    };
  }

  /**
   * Check if undo/redo is available for an agent.
   */
  getUndoRedoState(agentName: string): {
    canUndo: boolean;
    canRedo: boolean;
    undoDepth: number;
    redoDepth: number;
  } {
    const checkpoints = this.getTurnCheckpoints(agentName);
    const redoStack = this.redoStacks.get(agentName);
    return {
      canUndo: checkpoints.length > 0,
      canRedo: (redoStack?.length ?? 0) > 0,
      undoDepth: checkpoints.length,
      redoDepth: redoStack?.length ?? 0,
    };
  }

  // ==========================================================================
  // Turn checkpoint internals
  // ==========================================================================

  private recordTurnCheckpoint(agentName: string): void {
    const turnIndex = this.turnCounters.get(agentName) ?? 0;
    this.turnCounters.set(agentName, turnIndex + 1);

    const checkpoint: TurnCheckpoint = {
      agentName,
      turnIndex,
      sequenceBefore: this.store.currentSequence(),
      branchName: this.store.currentBranch().name,
      timestamp: Date.now(),
    };

    const checkpoints = this.getTurnCheckpoints(agentName);
    checkpoints.push(checkpoint);

    // Trim to max depth
    if (checkpoints.length > MAX_TURN_CHECKPOINTS) {
      checkpoints.splice(0, checkpoints.length - MAX_TURN_CHECKPOINTS);
    }

    this.saveTurnCheckpoints(agentName, checkpoints);
  }

  /**
   * Checkpoints live in one Tree state (TURN_CHECKPOINTS_TREE_ID) keyed by agent
   * name, each key pointing at a JSON blob of that agent's ≤MAX_TURN_CHECKPOINTS
   * list. This kills two unbounded-in-agents-ever dimensions at once:
   *
   *  - the original single Record<agentName, list> map was rewritten whole on
   *    every turn of every agent and never evicted a departed subagent's key;
   *  - the intermediate design (one state slot per agent) fixed the writes but
   *    leaked a permanent chronicle state *registration* per spawn — chronicle
   *    has no deregistration, and the state index is rewritten and fsynced on
   *    every sync tick, so per-tick cost grew with fleet history anyway.
   *
   * A tree gives per-key O(entry) writes, real key removal (treeRemove), and
   * exactly one registration for the life of the store. The legacy map state
   * (TURN_CHECKPOINTS_ID) is kept as a read-only fallback for stores written
   * before the split; eviction tombstones legacy keys so a reused agent name
   * can't inherit a dead agent's checkpoints through the fallback.
   */
  private legacyCheckpointKeys: Set<string> | null = null;

  private hasLegacyCheckpoints(agentName: string): boolean {
    if (!this.legacyCheckpointKeys) {
      const legacy = this.store.getStateJson(TURN_CHECKPOINTS_ID);
      this.legacyCheckpointKeys = new Set(
        legacy && typeof legacy === 'object' ? Object.keys(legacy) : []
      );
    }
    return this.legacyCheckpointKeys.has(agentName);
  }

  private getTurnCheckpoints(agentName: string): TurnCheckpoint[] {
    const entry = this.store.treeGet(TURN_CHECKPOINTS_TREE_ID, agentName);
    if (entry) {
      const blob = this.store.getBlob(entry.blobHash);
      if (!blob) return [];
      try {
        const parsed = JSON.parse(blob.toString());
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    if (!this.hasLegacyCheckpoints(agentName)) return [];
    const legacy = this.store.getStateJson(TURN_CHECKPOINTS_ID) as
      | Record<string, TurnCheckpoint[]>
      | null;
    const list = legacy?.[agentName];
    return Array.isArray(list) ? [...list] : [];
  }

  private saveTurnCheckpoints(agentName: string, checkpoints: TurnCheckpoint[]): void {
    const bytes = Buffer.from(JSON.stringify(checkpoints));
    const blobHash = this.store.storeBlob(bytes, 'application/json');
    this.store.treeSet(TURN_CHECKPOINTS_TREE_ID, agentName, {
      blobHash,
      size: bytes.length,
      mode: 0o644,
    });
  }

  /**
   * Drop a departed agent's checkpoint tree key and turn/redo bookkeeping.
   * Without this, spawn-and-dispose agents leave a key (and in-memory map
   * entries) behind for the life of the store/session.
   */
  private evictTurnCheckpoints(agentName: string): void {
    this.turnCounters.delete(agentName);
    this.redoStacks.delete(agentName);
    // Diagnostics maps are also keyed by agent name and never evicted —
    // spawn-and-dispose fleets would grow them for the session's life.
    this.staleWarnAt.delete(agentName);
    this.lastInferenceAt.delete(agentName);
    const entry = this.store.treeGet(TURN_CHECKPOINTS_TREE_ID, agentName);
    if (this.hasLegacyCheckpoints(agentName)) {
      // A bare treeRemove would resurrect the legacy map's list through the
      // fallback next time this name is reused — shadow it with an empty
      // tombstone instead. size <= 2 ⇔ the blob is already "[]".
      if (!entry || entry.size > 2) {
        this.saveTurnCheckpoints(agentName, []);
      }
      return;
    }
    if (entry) {
      this.store.treeRemove(TURN_CHECKPOINTS_TREE_ID, agentName);
    }
  }

  /**
   * Run until the queue is empty and all agents are idle.
   * Useful for testing.
   */
  async runUntilIdle(): Promise<void> {
    while (
      !this.queue.isEmpty ||
      // Direct inference requests (e.g. runEphemeralToCompletion) bypass the
      // event queue — without this the loop can exit before they're drained.
      this.pendingRequests.length > 0 ||
      this.activeStreams.size > 0 ||
      Array.from(this.agents.values()).some((a) => a.state.status !== 'idle')
    ) {
      await this.processNextEvent();
    }
  }

  private async createAgent(config: AgentConfig): Promise<Agent> {
    // Create context manager for this agent
    const contextManager = await ContextManager.open({
      store: this.store,
      namespace: `agents/${config.name}`,
      strategy: config.strategy ?? new PassthroughStrategy(),
      // Context Manager complete() calls are auxiliary work; the primary
      // streaming agent keeps the original Membrane.
      membrane: this.auxiliaryMembraneFor(config.name),
      debugLogContext: !!process.env.DEBUG_CONTEXT,
    });

    const agent = new Agent(config, contextManager, this.membrane);
    const restoredSettings = this.readAgentRuntimeSettings(config.name);
    if (restoredSettings) {
      agent.restoreRuntimeSettings(
        this.validatePersistedAgentRuntimeSettings(config.name, restoredSettings),
      );
    }
    this.agents.set(config.name, agent);
    this.agentConfigs.set(config.name, config);

    // First non-ephemeral agent becomes the primary for message routing
    if (!this.primaryAgentName) {
      this.primaryAgentName = config.name;
    }

    return agent;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.processNextEvent();
      } catch (error) {
        console.error('Error in event loop:', error);
      }
    }
  }

  private async processNextEvent(): Promise<void> {
    // Try to get next process event (with timeout to check running flag)
    const event = this.queue.tryPop();

    if (event) {
      await this.handleProcessEvent(event);
    }

    // Close idle conversation forks (no-op unless conversations configured)
    this.sweepExpiredConversations();

    // Check for inference requests
    await this.processInferenceRequests();

    // Yield to the event loop between iterations. A pending inference request
    // is not necessarily runnable: while its agent is streaming or waiting for
    // tools, processInferenceRequests() deliberately requeues it. Treating that
    // requeued request as "work made progress" creates a microtask-only polling
    // loop. If activeStreams bookkeeping is absent/stale at the same time, the
    // old code had no await at all and starved the tool-result and HTTP I/O that
    // could make the agent runnable again (the Sol outage, 2026-07-15).
    //
    // No queue event means no foreground progress, so always take the normal
    // polling backoff. After an event, retain the low-latency macrotask yield
    // while background work remains. Both paths give Bun/Node a real event-loop
    // turn; neither can recurse forever through already-resolved promises.
    if (!event) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    } else if (this.pendingRequests.length > 0 || this.activeStreams.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async handleProcessEvent(event: ProcessEvent): Promise<void> {
    const startTime = Date.now();

    // Handle tool results FIRST — before any module dispatch or MCPL handling.
    // This ensures the tool_use → tool_result message adjacency required by the
    // Anthropic API.  If we let modules or MCPL handlers run first they may add
    // messages between tool_use and tool_result, causing a 400 error.
    if (event.type === 'tool-result') {
      // Script-inner tool calls (client-side programmatic tool calling):
      // resolve the waiter and stop. These calls belong to a RUNNING
      // code_execution script, not to the agent's pending tool round — they
      // must not touch agent state (and must resolve even for ephemeral
      // agents that aren't in this.agents, or after the agent's own round
      // has already settled).
      const scriptWaiter = this.scriptToolWaiters.get(event.callId);
      if (scriptWaiter) {
        this.scriptToolWaiters.delete(event.callId);
        scriptWaiter(event.result);
        return;
      }

      const agent = this.agents.get(event.agentName);
      if (agent) {
        this.touchEphemeralRun(event.agentName, true);
      }
      if (!agent) {
        console.warn(
          `[framework] Dropping tool-result for unknown agent '${event.agentName}' (callId=${event.callId}). ` +
          `Agent may have been destroyed while tool was executing.`
        );
      } else if (agent.state.status !== 'waiting_for_tools') {
        console.warn(
          `[framework] Dropping tool-result for agent '${event.agentName}' — ` +
          `expected status 'waiting_for_tools' but got '${agent.state.status}' (callId=${event.callId}). ` +
          `Agent may have been reset/cancelled while tool was executing.`
        );
        this.emitTrace({
          type: 'tool:result_dropped',
          agentName: event.agentName,
          callId: event.callId,
          agentStatus: agent.state.status,
          result: event.result,
        });
      }
      if (agent && agent.state.status === 'waiting_for_tools') {
        agent.provideToolResult(event.callId, event.result);

        // Check if agent is now ready (state may have changed after provideToolResult)
        // Cast to AgentState to bypass TypeScript's control flow narrowing
        const currentState = agent.state as AgentState;
        if (currentState.status === 'ready') {
          // Flush pending assistant blocks (tool_use + preamble text) to context
          const pendingBlocks = this.pendingAssistantBlocks.get(agent.name);
          if (pendingBlocks) {
            agent.addAssistantResponse(pendingBlocks);
            this.pendingAssistantBlocks.delete(agent.name);
          }

          // Effective inline cap: agent_settings override → durable config →
          // house default, clamped to the strategy bound (see resolver).
          const maxChars = this.resolveToolResultInlineCap(agent).cap;

          // Oversized results — successes AND errors — spill to a workspace
          // file (truncated preview + file reference) instead of being
          // blind-truncated. Computed ONCE per call and reused for both the
          // history copy and the live wire copy below — the two must stay
          // byte-matched (the window stores what the membrane sends;
          // divergence breaks the compile prefix).
          const { blocks: toolResultContent, spilled } =
            await this.buildStoredToolResultContent(currentState.toolResults, maxChars);
          agent.getContextManager().addMessage('user', toolResultContent);

          // Flush any messages that were deferred while this turn was in
          // flight. Route to the PRIMARY agent — deferred messages are
          // framework-level (module messages, push events, subagent return
          // notifications) meant for the main conversation.
          //
          // Hear-while-acting: messages flushed into THIS agent's own window
          // are also collected for mid-turn injection — passed to the membrane
          // with the tool results below, so the NEXT inference round of the
          // live turn sees them instead of the agent staying deaf until the
          // turn ends. The window stores them here, right after the
          // tool_result message, which is exactly where the membrane appends
          // them in the live conversation — same participant, same content
          // blocks, same metadata, and compile() emits recent messages
          // verbatim, so the next turn's compiled prefix byte-matches the
          // live request (prompt-cache safe).
          //
          // The queue is drained ONLY at the target agent's own boundary:
          // draining at another agent's boundary would store the messages
          // mid-turn in the target's window without injecting them into the
          // target's live stream (deaf agent + window/live divergence). Left
          // queued, they flush at the target's own next boundary — with
          // injection — or in driveStream's finally when its turn ends.
          const midTurnInjections: Array<{ participant: string; content: ContentBlock[]; metadata?: MessageMetadata }> = [];
          if (this.deferredMessages.length > 0) {
            const target = (this.primaryAgentName ? this.agents.get(this.primaryAgentName) : undefined) ?? agent;
            if (target === agent) {
              const deferred = this.deferredMessages.splice(0);
              for (const msg of deferred) {
                target.getContextManager().addMessage(msg.participant, msg.content, msg.metadata);
                // Injection guards: tool blocks would corrupt the tool-cycle
                // structure the membrane enforces, and a message named as the
                // agent itself would render as an ASSISTANT turn on the wire
                // (an unintended prefill the model would continue). Such
                // messages stay window-only — visible next turn.
                const hasToolBlocks = msg.content.some(
                  (b) => b.type === 'tool_use' || b.type === 'tool_result'
                );
                if (!hasToolBlocks && msg.participant !== agent.name) {
                  midTurnInjections.push({
                    participant: msg.participant,
                    content: msg.content,
                    ...(msg.metadata ? { metadata: msg.metadata } : {}),
                  });
                }
              }
            }
          }

          // A newly injected CONVERSATIONAL message begins a new
          // conversational round inside the same provider inference. Remember
          // that boundary for driveStream: an explicit send in the preceding
          // round must not silence the reply. Routing is deliberately NOT
          // affected — the turn locus is frozen at turn start, so ambient
          // chatter, reactions, and system markers injected mid-turn can no
          // longer hijack where the agent's prose lands. Non-conversational
          // injections (reactions, `system: true` markers) don't even clear
          // the send suppression: nothing new was said to the agent.
          if (midTurnInjections.some((inj) => isConversationalInjection(inj.metadata))) {
            this.midTurnInputSignals.add(agent.name);
          }

          // Check if any tool result requested endTurn
          const shouldEndTurn = currentState.toolResults.some(tc => tc.result.endTurn);

          // Check if accumulated input tokens exceed the agent's budget
          const overBudget = currentState.stream
            && agent.lastStreamInputTokens > 0
            && agent.lastStreamInputTokens > agent.maxStreamTokens;

          // Physical-window projection (issue #92): a turn's continuation
          // rounds append to the compiled request without recompiling, so a
          // turn that starts near the compile target can walk past the
          // provider's HARD cap mid-turn and take a wire 400 — the compile
          // was legal, the growth wasn't. Project the next round's real size
          // (cache-inclusive input of the prior round + the blocks about to
          // be appended + reserve for the response) and, when it would cross
          // the physical window, break the stream through the same
          // budget-restart path — a fresh compile folds the history back
          // under budget instead of dispatching a doomed request.
          // Projection terms: prior round's real input + prior round's
          // OUTPUT (the just-generated thinking/text/tool_use joins the next
          // round's input — omitting it is a systematic underestimate) +
          // blocks about to be appended + reserve for the next response.
          const projectedRealTokens = currentState.stream
            && agent.physicalWindowTokens !== undefined
            && agent.lastStreamRealInputTokens > 0
            ? agent.lastStreamRealInputTokens
              + agent.lastStreamOutputTokens
              + estimateAppendedRoundTokens(currentState.toolResults, spilled, midTurnInjections)
              + agent.maxTokens
            : 0;
          const overPhysical = projectedRealTokens > (agent.physicalWindowTokens ?? Infinity);

          // Addressed re-pin (2026-07-31 Mythos misroutes, antra-ratified):
          // when someone ADDRESSES the agent mid-turn from another channel
          // (mention / reply / DM — the same chat:addressed signal the
          // turn-START batch policy prefers), the agent's subsequent plain
          // prose almost always answers THEM. Six recorded misroutes
          // delivered those answers to the stale frozen locus instead (the
          // LabClaude answer into #hospital_commons mid-examination; the
          // hospital scene into antra's DM). Re-pin the turn locus to the
          // LAST addressed conversational injection, at segment granularity:
          // prose routed in earlier rounds already went to the old pin,
          // which was correct when it was delivered. Ambient chatter,
          // reactions, and system markers still cannot move the pin — the
          // 2026-07-21 Cairn hijack protection is unchanged; this extends
          // the ratified addressed-outranks-ambient principle from turn
          // start to boundaries. Locus mode only (explicit mode has no pin).
          // Skipped on endTurn/overBudget: no further prose this stream, and
          // a stale "for this turn" notice would be pure noise.
          //
          // The notice rides the SAME injection batch — stored right after
          // the flushed messages and appended to midTurnInjections — so the
          // window byte-matches the wire (short event-style notice: the
          // classifier-safe D-class from the 2026-07-24 ablation). It also
          // updates lastAnnouncedLocus so the next turn's announce-on-change
          // diffs against what the agent was actually last told.
          if (
            (agent.proseRouting === 'locus' || agent.proseRouting === 'hybrid') &&
            !shouldEndTurn && !overBudget && currentState.stream
          ) {
            // Two signals qualify an injection to move the pin (n=6 + n=7):
            //  - chat:addressed — someone explicitly spoke TO the agent
            //    (mention / reply / DM);
            //  - a conversational follow-up in a channel the agent itself
            //    explicitly sent into THIS turn (turnEngagedChannels) —
            //    conversation the agent just engaged continues without
            //    re-mentioning it (2026-07-31: q's #portables reply, no @,
            //    answered in prose that followed the stale pin into
            //    repligate's DM). Deliberately NO author-kind filter: this
            //    fleet's participants include agent-residents whose speech
            //    is as conversational as anyone's — the Discord bot flag
            //    tracks nothing that matters here (antra, 2026-07-31).
            //    Reactions and system markers are already excluded by
            //    isConversationalInjection, and the engaged-this-turn scope
            //    keeps unrelated channels from moving the pin.
            const engaged = this.turnEngagedChannels.get(agent.name);
            const lastQualifying = [...midTurnInjections].reverse().find((inj) => {
              const m = inj.metadata as Record<string, unknown> | undefined;
              if (!isConversationalInjection(inj.metadata)) return false;
              if (typeof m?.channelId !== 'string') return false;
              const tags = m.tags as string[] | undefined;
              if (isAddressedMessage(tags, m)) return true;
              return engaged?.has(m.channelId as string) === true;
            });
            const newLocus = (lastQualifying?.metadata as Record<string, unknown> | undefined)
              ?.channelId as string | undefined;
            if (newLocus && this.turnLocusPins.get(agent.name) !== newLocus) {
              const prevPin = this.turnLocusPins.get(agent.name) ?? null;
              this.turnLocusPins.set(agent.name, newLocus);
              this.lastAnnouncedLocus.set(agent.name, newLocus);
              const label = this.channelRegistry?.getDescriptor(newLocus)?.label;
              const shown = label && label !== newLocus
                ? `${label.startsWith('#') ? label : `#${label}`} (${newLocus})`
                : newLocus;
              const noticeContent: ContentBlock[] = [{
                type: 'text',
                text:
                  `[routing] The conversation moved to ${shown} — your plain ` +
                  'speech now lands there for the rest of this turn. Other ' +
                  'channels need an explicit send tool.',
              }];
              const noticeMeta = { system: true, kind: 'routing-notice' } as MessageMetadata;
              try {
                const id = agent.getContextManager().addMessage('user', noticeContent, noticeMeta);
                this.emitTrace({ type: 'message:added', messageId: id, source: 'routing-notice' });
                midTurnInjections.push({ participant: 'user', content: noticeContent, metadata: noticeMeta });
                console.error(
                  `[routing] ${agent.name}: mid-turn addressed re-pin ${prevPin ?? '(none)'} -> ${newLocus}`,
                );
              } catch (err) {
                console.error('mid-turn locus re-pin: failed to record routing notice:', err);
              }
            }
          }

          if (shouldEndTurn) {
            // endTurn: messages already stored above, cancel stream, reset to idle.
            if (currentState.stream) {
              this.frameworkCancelledStreams.set(`${agent.name}:${agent.streamId}`, 'turn_ended');
              currentState.stream.cancel();
            }
            agent.reset();
            // The turn is over — release the gate here, not just in the abort
            // handler: the membrane's aborted event is asynchronous and the
            // agent must be wakeable the moment it goes idle. (Idempotent;
            // driveStream's finally is the backstop.)
            this.eventGate?.onInferenceEnded(agent.name);
            this.settleAgent(agent.name, { stopReason: 'turn_ended', speech: '' });
            this.emitTrace({ type: 'inference:turn_ended', agentName: agent.name });
          } else if (overBudget || overPhysical) {
            // Context budget exceeded: break the stream, let compile() compress.
            // Mark the cancel as framework-initiated BEFORE cancelling: the
            // membrane delivers `aborted` before the restart bumps streamId,
            // and without the marker the abort handler treats the restart as
            // a terminal failure — rejecting an ephemeral's promise mid-run
            // and emitting a spurious inference:exhausted (same race shape as
            // endTurn above).
            if (currentState.stream) {
              this.frameworkCancelledStreams.set(`${agent.name}:${agent.streamId}`, 'budget_restart');
              // Cancel the LIVE stream object directly (like the endTurn
              // branch above): at a tool boundary the state machine reads
              // 'ready', and Agent.cancelStream only signals the stream from
              // 'streaming'/'waiting_for_tools' — so the old call left the
              // provider stream parked forever awaiting tool results that
              // would never come (zombie: driveStream's finally never ran,
              // its activeStreams entry survived until the restart's stream
              // overwrote it). Harmless by accident before turn-alive
              // tracking; a genuine teardown leak after it.
              currentState.stream.cancel();
            }
            agent.cancelStream();
            this.emitTrace({
              type: 'inference:stream_restarted',
              agentName: agent.name,
              // 'physical_window' only when the budget check alone would
              // have let the doomed request through — overBudget keeps its
              // established label for existing consumers.
              reason: overBudget ? 'context_budget' : 'physical_window',
              inputTokens: overBudget ? agent.lastStreamInputTokens : projectedRealTokens,
              budget: overBudget ? agent.maxStreamTokens : (agent.physicalWindowTokens ?? 0),
            });
            this.pendingRequests.push({
              agentName: agent.name,
              reason: 'context_budget_restart',
              source: 'framework',
              timestamp: Date.now(),
            });
          } else if (currentState.stream) {
            // Streaming path: convert results and resume the stream.
            // Mid-turn messages collected above ride along as injected user
            // messages (membrane ≥0.5.72) — appended after the tool_result
            // envelope so the next round of THIS turn hears them.
            const membraneResults = currentState.toolResults.map(tc =>
              this.toMembraneToolResult(tc.id, tc.result, maxChars, spilled.get(tc.id))
            );
            currentState.stream.provideToolResults(
              membraneResults,
              midTurnInjections.length > 0 ? { injectedMessages: midTurnInjections } : undefined,
            );
            agent.setStreaming(currentState.stream);
            this.emitTrace({
              type: 'inference:stream_resumed',
              agentName: agent.name,
              ...(midTurnInjections.length > 0 ? { injectedMessages: midTurnInjections.length } : {}),
            });
          } else {
            // Non-streaming fallback: schedule re-inference
            this.pendingRequests.push({
              agentName: agent.name,
              reason: 'tool_results_ready',
              source: 'framework',
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    // Built-in: convert MCPL events to context messages.
    // These events are protocol-level (spec Sections 9 & 14) and always
    // represent content intended for the model's context window.
    if (event.type === 'mcpl:channel-incoming') {
      await this.handleMcplChannelIncoming(event as unknown as {
        type: 'mcpl:channel-incoming';
        serverId: string;
        channelId: string;
        messageId: string;
        threadId?: string;
        author: { id: string; name: string };
        content: ContentBlock[];
        timestamp: string;
        metadata?: Record<string, unknown>;
        triggerInference?: boolean;
      });
    } else if (event.type === 'mcpl:push-event') {
      this.handleMcplPushEvent(event as unknown as McplPushEvent);
    }

    // Dispatch to all modules, tracking responses with module names
    const responses: ModuleProcessResponse[] = [];
    for (const module of this.moduleRegistry.getAllModules()) {
      try {
        const processState = this.moduleRegistry.createProcessState(module.name);
        const response = await module.onProcess(event, processState);
        responses.push({ moduleName: module.name, response });
      } catch (error) {
        console.error(`Module ${module.name} error handling process event:`, error);
      }
    }

    // Apply responses
    for (const { moduleName, response } of responses) {
      await this.applyProcessResponse(response, event, moduleName);
    }

    // Handle tool calls specially
    if (event.type === 'tool-call') {
      this.dispatchToolCallEvent(event);
    }

    const durationMs = Date.now() - startTime;

    // Always emit trace for observability (UI needs this)
    this.emitTrace({ type: 'process:completed', processEvent: event, responses, durationMs });

    // Log to Chronicle (if enabled)
    if (this.processLoggingPersist) {
      this.logProcessEvent(event, responses);
    }
  }

  private async applyProcessResponse(
    response: EventResponse,
    event: ProcessEvent,
    moduleName: string
  ): Promise<void> {
    // Add messages
    if (response.addMessages) {
      for (const msg of response.addMessages) {
        const id = this.addMessage(msg.participant, msg.content, msg.metadata);
        this.emitTrace({ type: 'message:added', messageId: id, source: event.type });
      }
    }

    // Edit messages
    if (response.editMessages) {
      for (const edit of response.editMessages) {
        this.editMessage(edit.messageId, edit.content);
      }
    }

    // Remove messages
    if (response.removeMessages) {
      for (const id of response.removeMessages) {
        this.removeMessage(id);
      }
    }

    // Apply module state update atomically with message operations
    if (response.stateUpdate !== undefined) {
      this.moduleRegistry.setModuleState(moduleName, response.stateUpdate);
    }

    // Queue inference requests
    if (response.requestInference) {
      const source = 'source' in event ? (event as { source: string }).source : 'unknown';

      // Gate non-MCPL events (MCPL events are already gated in PushHandler/ChannelRegistry)
      if (this.eventGate && event.type !== 'mcpl:push-event' && event.type !== 'mcpl:channel-incoming') {
        const decision = this.eventGate.evaluate({
          ...extractGateFields(event),
          eventType: event.type,
          serverId: source,
          channelId: '',
        });
        if (!decision.trigger) return;
      }

      // Broadcast requests exclude conversation forks — they are driven by
      // their own channel's messages, not by framework-wide events.
      const targetAgents =
        response.requestInference === true
          ? Array.from(this.agents.keys()).filter((n) => !this.conversationAgentHomes.has(n))
          : response.requestInference;

      for (const agentName of targetAgents) {
        const agent = this.agents.get(agentName);
        if (agent && agent.canBeTriggeredBy(source)) {
          this.pendingRequests.push({
            agentName,
            reason: event.type,
            source,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  // ==========================================================================
  // Built-in MCPL event → context message conversion
  // ==========================================================================

  /**
   * Convert an incoming MCPL channel message to a context message.
   * This replaces the old MCPLModule.onProcess() message conversion.
   */
  private async handleMcplChannelIncoming(event: {
    type: 'mcpl:channel-incoming';
    serverId: string;
    channelId: string;
    messageId: string;
    threadId?: string;
    author: { id: string; name: string };
    content: ContentBlock[];
    timestamp: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    triggerInference?: boolean;
  }): Promise<void> {
    const metadata: Record<string, unknown> = {
      ...event.metadata,
      channelId: event.channelId,
      messageId: event.messageId,
      author: event.author,
      triggered: event.triggerInference ?? false,
      serverId: event.serverId,
    };
    if (event.threadId) metadata.threadId = event.threadId;
    if (event.tags) metadata.tags = event.tags;

    // Per-channel conversation routing: messages go to the channel's fork
    // agent (spawned from the template on first qualifying message), never
    // to the primary conversation.
    if (this.conversationRouter) {
      await this.routeConversationIncoming(event, metadata);
      return;
    }

    // Addressed-while-closed invitation — parity with the push-event path
    // (channels.publish surfaces like portal-mcpl deliver mentions here).
    const incomingContent = [...event.content];
    {
      const invitation = this.buildClosedChannelInvitation({
        serverId: event.serverId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorName: event.author?.name || 'Someone',
        guildName: typeof event.metadata?.guildName === 'string' && event.metadata.guildName
          ? (event.metadata.guildName as string)
          : undefined,
        tags: event.tags,
        missedMessages: typeof event.metadata?.missedMessages === 'number'
          ? event.metadata.missedMessages
          : undefined,
        missedCharacters: typeof event.metadata?.missedCharacters === 'number'
          ? event.metadata.missedCharacters
          : undefined,
      });
      if (invitation) {
        incomingContent.push(invitation.block);
        Object.assign(metadata, invitation.metadataPatch);
      }
    }

    const id = this.addMessage('user', incomingContent, metadata);
    this.emitTrace({ type: 'message:added', messageId: id, source: 'mcpl:channel-incoming' });

    if (event.triggerInference) {
      const addressed = isAddressedMessage(event.tags, event.metadata);
      for (const agentName of this.agents.keys()) {
        this.pendingRequests.push({
          agentName,
          reason: 'mcpl:channel-incoming',
          source: event.serverId,
          timestamp: Date.now(),
          // Route this turn's auto-published speech back to THIS channel, not
          // the global most-recent-inbound locus (item-3 redux, trunk agents).
          channelId: event.channelId,
          // Addressed messages outrank ambient chatter when a batched wake
          // picks the turn's frozen speech locus.
          addressed,
        });
      }
    }
  }

  /**
   * Route an incoming channel message through the ConversationRouter:
   * deliver to the channel's bound fork agent, spawning it from the template
   * agent first when the bind policy matches. Unrouted messages are dropped —
   * the template ("trunk") is a dormant warm checkpoint, not a listener.
   */
  private async routeConversationIncoming(
    event: {
      serverId: string;
      channelId: string;
      messageId: string;
      author: { id: string; name: string };
      content: ContentBlock[];
      metadata?: Record<string, unknown>;
      tags?: string[];
      triggerInference?: boolean;
    },
    messageMetadata: Record<string, unknown>,
  ): Promise<void> {
    const router = this.conversationRouter!;
    const descriptor = this.channelRegistry?.getDescriptor(event.channelId);

    const decision = router.route({
      channelId: event.channelId,
      mentioned: event.metadata?.mentioned === true,
      kind: ConversationRouter.classifyChannel(descriptor, event.metadata),
    });

    if (decision.kind === 'unbound') {
      this.emitTrace({
        type: 'mcpl:conversation-unrouted',
        channelId: event.channelId,
        messageId: event.messageId,
      });
      return;
    }

    let agent: Agent | undefined;
    if (decision.kind === 'spawn') {
      try {
        agent = await this.createConversationAgent(decision.agentName, event.channelId);
        router.bind(event.channelId, decision.agentName, decision.generation);
        this.persistConversationRouterState();
        this.emitTrace({
          type: 'mcpl:conversation-spawned',
          channelId: event.channelId,
          agentName: decision.agentName,
          generation: decision.generation,
          template: router.templateAgent,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Failed to spawn conversation agent for ${event.channelId}:`, err);
        this.emitTrace({
          type: 'mcpl:conversation-spawn-failed',
          channelId: event.channelId,
          agentName: decision.agentName,
          error: err.message,
        });
        return; // next qualifying message proposes the same spawn again
      }
    } else {
      agent = this.agents.get(decision.agentName);
      if (!agent) {
        // Bound agent vanished (e.g. external reset) — unbind so the next
        // qualifying message respawns a fresh fork.
        router.unbind(event.channelId);
        this.emitTrace({
          type: 'mcpl:conversation-binding-orphaned',
          channelId: event.channelId,
          agentName: decision.agentName,
        });
        return;
      }
    }

    // Respect an explicit server-config-level veto (shouldTriggerInference)
    // on top of the router's own trigger policy.
    const trigger = decision.trigger && event.triggerInference !== false;
    messageMetadata.triggered = trigger;

    const id = agent.getContextManager().addMessage('user', event.content, messageMetadata);
    this.emitTrace({ type: 'message:added', messageId: id, source: 'mcpl:channel-incoming' });

    if (trigger) {
      this.pendingRequests.push({
        agentName: agent.name,
        reason: 'mcpl:channel-incoming',
        source: event.serverId,
        timestamp: Date.now(),
        // A fork's home channel wins in routeSpeech regardless, but carry the
        // triggering channel too so the trunk/active path stays consistent.
        channelId: event.channelId,
        addressed: isAddressedMessage(event.tags, event.metadata),
      });
    }
  }

  /**
   * Spawn a persistent per-channel conversation agent ("fork") from the
   * template agent: own ContextManager under `conversations/{name}`, seeded
   * with a copy of the template's compiled context (the SubagentModule
   * wholesale-copy pattern), registered in the event loop like any agent —
   * but never primary.
   */
  private async createConversationAgent(name: string, channelId: string): Promise<Agent> {
    const router = this.conversationRouter!;
    const templateConfig = this.agentConfigs.get(router.templateAgent);
    const template = this.agents.get(router.templateAgent);
    if (!template || !templateConfig) {
      throw new Error(`conversation template agent "${router.templateAgent}" not found`);
    }

    const contextManager = await ContextManager.open({
      store: this.store,
      namespace: `conversations/${name}`,
      isolate: true,
      // Strategy instances are stateful — never share the template's.
      strategy: router.strategyFactory?.() ?? new PassthroughStrategy(),
      // Dynamic conversation forks retain the established provider policy in
      // this bounded first slice. Provider cooldown ownership belongs to the
      // persistent resident only; generation-unique forks must not leak gates.
      membrane: this.membrane,
      debugLogContext: !!process.env.DEBUG_CONTEXT,
    });

    // Seed with the template's compiled context, renaming the template
    // participant so the fork reads its inheritance as its own history.
    // Guard: only seed a genuinely fresh namespace. Generation counters are
    // persisted precisely so names aren't reused, but if this namespace has
    // history anyway (counter state lost, crash between spawn and persist),
    // seeding again would stack another template copy on top of it.
    const { messages: existing } = await contextManager.compile();
    if (existing.length === 0) {
      const { messages: compiled } = await template.getContextManager().compile();
      for (const msg of compiled) {
        const participant = msg.participant === template.name ? name : msg.participant;
        contextManager.addMessage(participant, msg.content);
      }
    }

    const config: AgentConfig = { ...templateConfig, name, strategy: undefined };
    const agent = new Agent(config, contextManager, this.membrane);
    this.agents.set(name, agent);
    this.agentConfigs.set(name, config);
    this.conversationAgentHomes.set(name, channelId);
    return agent;
  }

  /** Persist the router's generation counters (see hydration in create()). */
  private persistConversationRouterState(): void {
    if (!this.conversationRouter) return;
    try {
      this.store.setStateJson(CONVERSATION_ROUTER_STATE_ID, {
        generations: this.conversationRouter.exportGenerations(),
      });
    } catch (error) {
      console.error('Failed to persist conversation router state:', error);
    }
  }

  /**
   * Remove a closed conversation fork from the framework: its closure turn
   * has finished, so the home mapping has served its purpose and keeping the
   * agent registered would just grow every agent scan and broadcast filter
   * forever. The fork's context stays in Chronicle for investigation.
   */
  private disposeConversationAgent(agentName: string): void {
    this.closingConversationAgents.delete(agentName);
    const channelId = this.conversationAgentHomes.get(agentName);
    this.agents.delete(agentName);
    this.agentConfigs.delete(agentName);
    this.conversationAgentHomes.delete(agentName);
    this.evictTurnCheckpoints(agentName);
    this.emitTrace({
      type: 'mcpl:conversation-disposed',
      agentName,
      channelId,
    });
  }

  /**
   * Scope MCPL context injections for a conversation-bound agent: drop
   * injections that are another open channel's context (injection namespace
   * = channelId by adapter convention), keep its own channel and anything
   * that isn't channel context.
   */
  private scopeInjectionsForAgent(
    agentName: string,
    injections: ContextInjection[],
  ): ContextInjection[] {
    const home = this.conversationAgentHomes.get(agentName);
    if (!home || !this.channelRegistry || injections.length === 0) {
      return injections;
    }
    const openChannelIds = new Set(
      this.channelRegistry.getOpenChannels().map((e) => e.descriptor.id),
    );
    return injections.filter((inj) => {
      const ns = inj.namespace;
      if (!ns || !openChannelIds.has(ns)) return true;
      return ns === home;
    });
  }

  /**
   * Idle-TTL sweep for conversation bindings (runs at most once per minute
   * from the event loop). Expired forks get a final system-initiated closure
   * turn — publish scoping still works because the agent's home channel
   * mapping is permanent — and the channel unbinds immediately, so the next
   * qualifying message spawns a fresh fork from the current template.
   */
  private sweepExpiredConversations(): void {
    if (!this.conversationRouter) return;
    const now = Date.now();
    if (now - this.lastConversationSweep < 60_000) return;
    this.lastConversationSweep = now;

    for (const binding of this.conversationRouter.expired(now)) {
      this.conversationRouter.unbind(binding.channelId);
      this.emitTrace({
        type: 'mcpl:conversation-closed',
        channelId: binding.channelId,
        agentName: binding.agentName,
        reason: 'idle-ttl',
      });

      const agent = this.agents.get(binding.agentName);
      if (!agent) {
        // Agent vanished (external reset) — nothing to close, just make sure
        // its bookkeeping doesn't linger.
        this.agentConfigs.delete(binding.agentName);
        this.conversationAgentHomes.delete(binding.agentName);
        continue;
      }
      agent.getContextManager().addMessage(
        'user',
        [{ type: 'text', text: this.conversationRouter.closurePrompt }],
        { channelId: binding.channelId, conversationClosure: true },
      );
      this.pendingRequests.push({
        agentName: binding.agentName,
        reason: 'conversation:closure',
        source: 'framework',
        timestamp: now,
      });
      // Disposed when the closure stream ends (driveStream finally), with
      // the reaper below as fallback.
      this.closingConversationAgents.add(binding.agentName);
    }

    // Fallback reaper: a closing fork whose closure inference never ran
    // (request dropped as stale, inference policy veto) would otherwise stay
    // registered forever. No active stream + no pending request = done.
    for (const agentName of [...this.closingConversationAgents]) {
      if (
        !this.activeStreams.has(agentName) &&
        !this.pendingRequests.some((r) => r.agentName === agentName)
      ) {
        this.disposeConversationAgent(agentName);
      }
    }
  }

  /**
   * Build the addressed-while-CLOSED channel invitation block, shared by the
   * push-event and channels/incoming ingest paths. Until 2026-07-27 only push
   * events (discord-mcpl mentions) carried it; channels.publish surfaces
   * (portal-mcpl) delivered bare mentions with no guidance and no route — an
   * explicit-prose agent's natural plain reply bounced with nowhere to go
   * (Rhys's first portal mention: a 2,320-char reply stranded).
   *
   * Wording: option 1 teaches the `>>` destination prefix, which delivers for
   * BOTH legacy (host-inferred) and explicit prose-routing agents. The
   * previous "simply write your reply as normal text" was a false promise
   * under explicit routing (the metadata flags it set had no consumers).
   *
   * Human-readable names wherever the surface provided them — a mind reading
   * this should see WHO addressed it WHERE, not a wall of snowflake ids. Raw
   * ids remain only inside the tool-argument instructions, where they are the
   * literal values to pass.
   *
   * 2026-08-05 accuracy pass: the old "you won't receive more from it unless
   * you join" was wrong in both directions — direct addresses (mentions,
   * replies to the agent) DO still arrive, and nothing warned that answering
   * via option 1 leaves the human's natural un-@'d follow-up invisible (Sol
   * answered four #architecture mentions over four days while the follow-ups
   * to her own replies were silently dropped). The wording now states the
   * actual delivery model, and option 1 carries the consequence inline. When
   * the surface tracks a missed-ambient tally (discord-mcpl sends
   * `missedMessages`/`missedCharacters` in push origin), the invitation shows
   * the count — the cost of staying out, as a number, at decision time.
   */
  private buildClosedChannelInvitation(opts: {
    serverId: string;
    channelId: string;
    channelLabel?: string;
    messageId: string;
    authorName: string;
    guildName?: string;
    tags?: string[];
    /** Ambient messages dropped in this channel while closed (surface-tracked). */
    missedMessages?: number;
    /** Characters across those dropped messages. */
    missedCharacters?: number;
  }): { block: ContentBlock; metadataPatch: Record<string, unknown> } | null {
    if (!this.channelRegistry) return null;
    if (!opts.tags?.includes('chat:addressed')) return null;
    if (this.channelRegistry.isChannelOpen(opts.channelId)) return null;
    const descriptor = this.channelRegistry.getDescriptor(opts.channelId);
    const maxBackscroll = descriptor?.capabilities?.history?.maxMessages ?? 0;
    const label = opts.channelLabel ?? descriptor?.label;
    const channelLabel = label ? `#${label}` : `"${opts.channelId}"`;
    const place = opts.guildName ? `${channelLabel} in "${opts.guildName}"` : channelLabel;
    const missedCount = opts.missedMessages ?? 0;
    const missedNote =
      missedCount > 0
        ? `While closed, ${missedCount} message${missedCount === 1 ? '' : 's'}` +
          (opts.missedCharacters ? ` (~${opts.missedCharacters} chars)` : '') +
          ` have passed there without you. `
        : '';
    const block: ContentBlock = {
      type: 'text',
      text:
        `\n[Channel invitation] ${opts.authorName} addressed you in ${place} — ` +
        `a channel you haven't joined. Only messages that address you directly (an @-mention or ` +
        `a reply to one of your messages) reach you from it; the rest of its traffic is invisible to you. ` +
        missedNote +
        `Your options:\n` +
        `1. Reply without joining — write your reply this turn prefixed with ">>${channelLabel}"; it will be delivered there. ` +
        `Note: follow-ups to your reply will NOT reach you unless they @-mention you or use the reply feature on your message.\n` +
        `2. Join the channel — call channel_open with channelId "${opts.channelId}" and serverId "${opts.serverId}"` +
        (maxBackscroll > 0
          ? `; to also read recent history, add backscroll (a number up to ${maxBackscroll}) and beforeMessageId "${opts.messageId}".\n`
          : `.\n`) +
        `3. Stay out — call channel_decline with channelId "${opts.channelId}", serverId "${opts.serverId}", ` +
        `and messageId "${opts.messageId}" (optionally set acknowledge to an emoji like 👀 so ${opts.authorName} isn't left hanging).\n` +
        `Doing nothing is also fine.`,
    };
    return {
      block,
      metadataPatch: {
        channelInvitation: true,
        channelOpen: false,
        channelId: opts.channelId,
        invitationMessageId: opts.messageId,
      },
    };
  }

  /**
   * Convert an MCPL push event to a context message.
   */
  private handleMcplPushEvent(event: McplPushEvent): void {
    const triggerChannel = this.derivePushEventChannel(event.origin);
    if (triggerChannel && this.channelRegistry) {
      this.channelRegistry.ensureChannelRegistered(
        event.serverId,
        triggerChannel.channelId,
        triggerChannel.label,
        triggerChannel.metadata,
      );
    }

    const metadata: Record<string, unknown> = {
      ...event.origin,
      serverId: event.serverId,
      featureSet: event.featureSet,
      eventId: event.eventId,
      triggered: event.triggerInference ?? false,
      ...(event.tags ? { tags: event.tags } : {}),
    };
    // `origin.channelId` is the server-internal raw id (a bare Discord
    // snowflake) — unroutable as a locus and unresolvable by the agent. Store
    // the composite MCPL id instead wherever we can derive it, so anything
    // downstream that reads `metadata.channelId` (routing, provenance, the
    // agent itself) sees the qualified form. The raw value stays available on
    // servers that also send `rawChannelId`-style origin fields.
    if (triggerChannel) {
      metadata.channelId = triggerChannel.channelId;
    }

    const content = [...event.content];
    if (triggerChannel) {
      const origin = (event.origin ?? {}) as Record<string, unknown>;
      const invitation = this.buildClosedChannelInvitation({
        serverId: event.serverId,
        channelId: triggerChannel.channelId,
        channelLabel: triggerChannel.label,
        messageId: typeof origin.messageId === 'string' ? origin.messageId : event.eventId,
        authorName: typeof origin.authorName === 'string' && origin.authorName ? origin.authorName : 'Someone',
        guildName: typeof origin.guildName === 'string' && origin.guildName ? origin.guildName : undefined,
        tags: event.tags,
        missedMessages: typeof origin.missedMessages === 'number' ? origin.missedMessages : undefined,
        missedCharacters:
          typeof origin.missedCharacters === 'number' ? origin.missedCharacters : undefined,
      });
      if (invitation) {
        content.push(invitation.block);
        Object.assign(metadata, invitation.metadataPatch);
      }
    }

    const id = this.addMessage('user', content, metadata);
    this.emitTrace({ type: 'message:added', messageId: id, source: 'mcpl:push-event' });

    if (event.triggerInference) {
      // Default broadcast excludes conversation forks (channel-driven).
      const targetAgents = event.targetAgents
        ?? [...this.agents.keys()].filter((n) => !this.conversationAgentHomes.has(n));
      for (const agentName of targetAgents) {
        this.pendingRequests.push({
          agentName,
          reason: 'mcpl:push-event',
          source: event.serverId,
          timestamp: Date.now(),
          channelId: triggerChannel?.channelId,
          // DMs and addressed-while-closed messages arrive as push events;
          // they must outrank ambient chatter in a batched wake's locus
          // selection just like their channels/incoming counterparts.
          addressed: isAddressedMessage(event.tags, event.origin),
        });
      }
    }
  }

  /**
   * Derive the MCPL composite channel id (the outbound routing locus) for a
   * push event from its server-defined `origin`, if it carries one.
   *
   * Discord DMs are the motivating case: discord-mcpl forwards them via
   * push/event (the DM channel is closed), so they never pass through
   * channels/incoming and their channel is never registered — leaving the
   * agent's reply with nowhere to route (item-3 redux, DM sub-case). Prefers an
   * explicit `origin.mcplChannelId` (a surface declaring its own composite id —
   * the surface-agnostic contract); otherwise reconstructs the Discord form
   * `discord:{guildId|dm}:{channelId}` from origin fields, matching
   * discord-mcpl's `mcplChannelId()` / `parseMcplChannelId()` convention so the
   * fix works even against a discord-mcpl build that predates `mcplChannelId`.
   * Returns undefined for push events with no channel provenance (heartbeats,
   * timers), which correctly keep the global fallback.
   */
  private derivePushEventChannel(
    origin: Record<string, unknown> | undefined,
  ): { channelId: string; label?: string; metadata?: Record<string, unknown> } | undefined {
    if (!origin) return undefined;
    let label = typeof origin.channelName === 'string' && origin.channelName ? origin.channelName : undefined;
    let metadata: Record<string, unknown> | undefined;

    // A DM has no channelName — label it by the PERSON and carry their
    // identity, so DM registrations are people-first (`DM: antra`, matchable
    // by `>>@name` / `<@id>` mention tokens) instead of bare snowflakes.
    const isDM = origin.isDM === true || origin.guildId === null;
    if (isDM && typeof origin.authorName === 'string' && origin.authorName) {
      label = label ?? `DM: ${origin.authorName}`;
      metadata = {
        channelType: 'dm',
        recipientName: origin.authorName,
        ...(typeof origin.authorId === 'string' && origin.authorId
          ? { recipientId: origin.authorId }
          : {}),
      };
    }

    const explicit = origin.mcplChannelId;
    if (typeof explicit === 'string' && explicit) {
      return { channelId: explicit, ...(label ? { label } : {}), ...(metadata ? { metadata } : {}) };
    }

    // Discord fallback: reconstruct the composite from origin parts. `guildId`
    // is null for a DM (→ 'dm'); a real guild id for a non-open guild channel.
    if (origin.source === 'discord' && typeof origin.channelId === 'string' && origin.channelId) {
      const guild =
        typeof origin.guildId === 'string' && origin.guildId ? origin.guildId : 'dm';
      return {
        channelId: `discord:${guild}:${origin.channelId}`,
        ...(label ? { label } : {}),
        ...(metadata ? { metadata } : {}),
      };
    }

    return undefined;
  }

  private async processInferenceRequests(): Promise<void> {
    if (this.pendingRequests.length === 0) {
      return;
    }

    const STALE_REQUEST_MS = 30_000;
    const now = Date.now();
    const state = this.createFrameworkState();

    // Group requests by agent
    const requestsByAgent = new Map<string, InferenceRequest[]>();
    for (const req of this.pendingRequests) {
      const existing = requestsByAgent.get(req.agentName) ?? [];
      existing.push(req);
      requestsByAgent.set(req.agentName, existing);
    }

    // Clear pending (we'll re-add if inference doesn't run)
    this.pendingRequests = [];

    // Check each agent
    for (const [agentName, groupedRequests] of requestsByAgent) {
      let requests = groupedRequests;
      const agent = this.agents.get(agentName);
      if (!agent) {
        // Agent not found — request is orphaned. Emit warning and drop.
        const oldest = Math.min(...requests.map(r => r.timestamp));
        this.emitTrace({
          type: 'inference:request_dropped',
          agentName,
          reason: 'agent_not_found',
          requestCount: requests.length,
          oldestRequestAge: now - oldest,
        });
        console.error(`[inference-dropped] agent=${agentName} reason=agent_not_found requests=${requests.length}`);
        continue;
      }

      const providerCooldown = this.providerAccelerationCooldowns?.get(agentName);
      if (providerCooldown) {
        if (now < providerCooldown.until) {
          for (const req of requests) {
            if (!providerCooldown.heldRequests.some((r) => this.sameInferenceRequest(r, req))) {
              providerCooldown.heldRequests.push(req);
            }
          }
          const recovery = this.providerAccelerationRecoveries.get(agentName);
          if (recovery) recovery.heldRequests = providerCooldown.heldRequests.length;
          // The timer owns release. Do not hot-poll these requests.
          continue;
        }
        // Timers can deliver late under load. Release synchronously and merge
        // the held causes into this one current compile.
        clearTimeout(providerCooldown.timer);
        this.providerAccelerationCooldowns.delete(agentName);
        const recovery = this.providerAccelerationRecoveries.get(agentName);
        if (recovery) recovery.releasedAt = now;
        requests = [...providerCooldown.heldRequests, ...requests];
      }

      // Skip if agent is busy (inferring, streaming, or waiting for tools) —
      // or if a turn is alive at all (activeTurnTokens): the state machine
      // goes idle at endTurn's reset while driveStream teardown is still
      // pending, and a successor turn dequeued in that gap compiles while the
      // predecessor's deferred flush can still write (2026-07-31 Mythos).
      // Turn-alive spans dequeue → settled teardown; wakes wait it out.
      //
      // EXCEPT a context-budget restart: it CONTINUES the turn whose token is
      // held — queueing it behind its own turn's teardown is a deadlock when
      // that teardown lags (the cancelled stream's `aborted` event is
      // asynchronous and, historically, not even guaranteed — see the
      // overBudget branch). The restart's startAgentStream overwrites the
      // token; the predecessor frame's late finally no-ops via token-match.
      // This mirrors how the restart has always overwritten activeStreams
      // rather than waiting for the old stream's teardown.
      const budgetRestart = requests.find((r) => r.reason === 'context_budget_restart');
      const turnAlive = !budgetRestart && this.activeTurnTokens.has(agentName);
      const providerGate = this.providerGates?.get(agentName);
      // A primary can own provider admission while yielding to an already in-flight
      // auxiliary call. Keep this agent's later wakes queued, but do not block the
      // framework event loop or other residents while that auxiliary call settles.
      const providerPrimaryWaiting = (providerGate?.primaryDepth ?? 0) > 0 && !this.activeTurnTokens.has(agentName);
      if (providerPrimaryWaiting || turnAlive || agent.state.status === 'inferring' || agent.state.status === 'streaming' || agent.state.status === 'waiting_for_tools') {
        // Re-queue requests, but warn if they've been pending too long
        const oldest = Math.min(...requests.map(r => r.timestamp));
        if (
          now - oldest > STALE_REQUEST_MS &&
          (this.staleWarnAt.get(agentName) ?? 0) < now - 60_000
        ) {
          // Trace and stderr share the throttle. The old code throttled only
          // stderr, so a long-running tool call generated one trace per poll
          // (up to 100/sec after the scheduler backoff), adding avoidable work
          // precisely while the agent was already under pressure.
          this.staleWarnAt.set(agentName, now);
          // Surface turn-alive separately from the state machine: status can
          // read 'idle' while a turn's teardown is pending, and a LEAKED turn
          // token would look exactly like this — permanently requeued wakes.
          // This line is the wedge's tell (idle+turn-alive, forever).
          const shownStatus = turnAlive && agent.state.status === 'idle'
            ? 'idle+turn-alive'
            : agent.state.status;
          this.emitTrace({
            type: 'inference:request_stale',
            agentName,
            agentStatus: shownStatus,
            requestCount: requests.length,
            oldestRequestAge: now - oldest,
          });
          console.error(
            `[inference-stale] agent=${agentName} busy (${shownStatus}) — ` +
            `${requests.length} request(s) waiting ${Math.round((now - oldest) / 1000)}s`,
          );
        }
        this.pendingRequests.push(...requests);
        continue;
      }

      // Check policy
      if (!this.inferencePolicy.shouldInfer(agentName, requests, state)) {
        // Loud drop: a queued request that dies here is otherwise invisible —
        // the 2026-07-09 mythos "not responding" diagnosis burned hours on
        // exactly this class of silent drop. One stderr line per drop.
        console.error(
          `[inference-dropped] agent=${agentName} reason=policy-skip ` +
          `requests=${requests.length} triggers=${requests.map((r) => r.reason).join(',')}`,
        );
        const gate = this.providerGates.get(agentName);
        if (gate?.primaryPending && this.providerAccelerationRecoveries.has(agentName)) {
          gate.primaryPending = false;
          this.providerAccelerationRecoveries.delete(agentName);
          this.flushAuxiliaryAdmission(agentName);
        }
        continue;
      }

      // Start streaming inference (non-blocking — driveStream runs in background)
      // The request that grants the turn-alive exception must also define the
      // downstream turn semantics. An ordinary wake can already be pending
      // when the tool boundary appends a context-budget restart; selecting
      // requests[0] in that mixed batch bypassed the turn lock because a
      // restart existed, then treated the continuation as a fresh turn.
      const trigger = budgetRestart ?? requests[0];
      // Route this turn's auto-published speech to the channel that triggered
      // it (item-3 redux). A batched wake may carry several triggering channels
      // (messages arrived in >1 channel while the agent was busy/idle):
      //   1. the most recent ADDRESSED channel wins (mention / reply / DM —
      //      someone explicitly spoke TO the agent);
      //   2. else the most recent channel-bearing request (ambient message in
      //      an open channel — legacy last-inbound semantics).
      // Ambient chatter must not outrank an addressed message just by being
      // newest (2026-07-21 Cairn lounge misroute, turn-start variant).
      // Non-channel wakes (heartbeats, module events, reactions — which never
      // carry channelId) leave both undefined → global fallback.
      let ambientChannel: string | undefined;
      let addressedChannel: string | undefined;
      for (const r of requests) {
        if (!r.channelId) continue;
        ambientChannel = r.channelId;
        if (r.addressed) addressedChannel = r.channelId;
      }
      const triggerChannel = addressedChannel ?? ambientChannel;
      const triggerAddressed = addressedChannel !== undefined;
      await this.startAgentStream(agent, {
        ...trigger,
        channelId: triggerChannel,
        addressed: triggerAddressed,
      });
    }
  }

  /** Record prose segments suppressed by explicit-send silencing. */
  private recordProseSuppression(agentName: string, count: number): void {
    if (count <= 0) return;
    this.turnProseSuppressed.set(agentName, (this.turnProseSuppressed.get(agentName) ?? 0) + count);
  }

  /** Record a successful plain-prose delivery for this turn's receipt. */
  private recordProseDelivery(
    agentName: string,
    outcome: { delivered: boolean; channelId: string } | null | undefined,
  ): void {
    if (!outcome?.delivered) return;
    let list = this.turnProseDeliveries.get(agentName);
    if (!list) {
      list = [];
      this.turnProseDeliveries.set(agentName, list);
    }
    list.push(outcome.channelId);
  }

  /**
   * Append the turn's `[delivered]` receipt: one compact system message
   * naming where this turn's plain prose actually landed (channels in
   * delivery order, deduped). Explicit sends receipt themselves via their
   * tool_result; auto-routed prose previously left no in-window trace, so
   * the agent could never see where its own words went — misroutes were
   * invisible to it until a human reported them (2026-07-31 series).
   * Called ONLY at logical turn end (stream 'complete', or the endTurn
   * cancel path after the speech chain settles) — never mid-stream, where a
   * window-only insert would diverge from the wire. No-op when the turn
   * delivered nothing. Failures are already marked separately
   * ([discord-send-failed]); this is the success half.
   */
  private appendProseDeliveryReceipt(agent: Agent): void {
    const list = this.turnProseDeliveries.get(agent.name);
    const suppressed = this.turnProseSuppressed.get(agent.name) ?? 0;
    if ((!list || list.length === 0) && suppressed === 0) return;
    this.turnProseDeliveries.delete(agent.name);
    this.turnProseSuppressed.delete(agent.name);
    const seen = new Set<string>();
    const shown: string[] = [];
    for (const id of list ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const label = this.channelRegistry?.getDescriptor(id)?.label;
      shown.push(
        label && label !== id
          ? `${label.startsWith('#') ? label : `#${label}`} (${id})`
          : id,
      );
    }
    const suppressedNote =
      suppressed > 0
        ? agent.proseRouting === 'disabled'
          ? `${suppressed} plain-speech segment(s) suppressed (proseRouting=disabled — publish only with an explicit send tool)`
          : `${suppressed} plain-speech segment(s) suppressed (explicit send in the same round — resend with a send tool if it was meant to be heard)`
        : '';
    const text =
      shown.length > 0
        ? `[delivered] plain speech → ${shown.join(' · ')}${suppressedNote ? ` · ${suppressedNote}` : ''}`
        : `[delivered] nothing — ${suppressedNote}`;
    try {
      const mid = agent.getContextManager().addMessage(
        'user',
        [{ type: 'text', text }],
        { system: true, kind: 'delivery-receipt' } as MessageMetadata,
      );
      this.emitTrace({ type: 'message:added', messageId: mid, source: 'delivery-receipt' });
    } catch (err) {
      console.error('delivery receipt append failed:', err);
    }
  }

  /**
   * Announce-on-change locus notice (turn-frozen routing). Appends a durable
   * `[routing]` window message when the turn's effective outbound locus
   * differs from the last one announced — the agent must never have to guess
   * where its plain prose lands. Durable append (never retracted) keeps the
   * KV prefix stable; change-only keeps it out of steady-state turns. The
   * first resolution after boot announces only a non-null locus ("prose has
   * no destination" is the unremarkable boot default). Never triggers
   * inference; never locus-eligible itself (system + no channel metadata).
   */
  private announceLocusIfChanged(agentName: string, locus: string | null): void {
    const hasBaseline = this.lastAnnouncedLocus.has(agentName);
    const prev = this.lastAnnouncedLocus.get(agentName) ?? null;
    if (hasBaseline ? prev === locus : locus === null) {
      if (!hasBaseline) this.lastAnnouncedLocus.set(agentName, locus);
      return;
    }
    this.lastAnnouncedLocus.set(agentName, locus);

    const agent = this.agents.get(agentName);
    if (!agent) return;

    let text: string;
    if (locus === null) {
      text =
        '[routing] Your plain speech currently has no channel — it stays in ' +
        'your archive. Use an explicit send tool to reach a channel.';
    } else {
      const label = this.channelRegistry?.getDescriptor(locus)?.label;
      const shown =
        label && label !== locus
          ? `${label.startsWith('#') ? label : `#${label}`} (${locus})`
          : locus;
      text =
        `[routing] Your plain speech now lands in ${shown}. ` +
        'Other channels need an explicit send tool.';
    }

    try {
      const id = agent.getContextManager().addMessage(
        'user',
        [{ type: 'text', text }],
        { system: true, kind: 'routing-notice' },
      );
      this.emitTrace({ type: 'message:added', messageId: id, source: 'routing-notice' });
      console.error(
        `[routing] ${agentName}: locus ${prev ?? '(none)'} -> ${locus ?? '(none)'} (announced in window)`,
      );
    } catch (err) {
      console.error('announceLocusIfChanged: failed to record routing notice:', err);
    }
  }

  /**
   * Durable window notice for a channel the agent did not ask to open —
   * subscription-policy admission, or an open forced by the agent's own
   * delivery into a closed channel. The agent must always learn that new
   * traffic will start flowing, and that `channel_close` opts out (their
   * decision outranks policy). System message: never triggers inference,
   * never conversational, never locus-eligible.
   */
  private recordChannelAutoOpenNotice(
    agentName: string | undefined,
    channels: Array<{ channelId: string; label?: string }>,
    cause: 'subscription-policy' | 'opened-by-delivery' | 'opened-by-reply',
  ): void {
    if (channels.length === 0) return;
    const shown = channels
      .map((c) => (c.label && c.label !== c.channelId ? `${c.label} (${c.channelId})` : c.channelId))
      .join(', ');
    const plural = channels.length > 1;
    const causeText =
      cause === 'subscription-policy'
        ? 'your subscription policy just admitted ' + (plural ? 'them' : 'it')
        : 'your own message into the closed channel engaged it';
    const text =
      `[channels] Now open: ${shown} — ${causeText}. Ongoing traffic from ` +
      (plural ? 'these channels' : 'this channel') +
      ` will reach you. If you don't want ${plural ? 'one of them' : 'it'}, use channel_close — ` +
      'your choice sticks; neither policy nor a later send will silently reopen it.';
    try {
      // Through framework.addMessage for mid-turn safety (deferral +
      // hear-while-acting injection) — a delivery-forced open happens inside
      // a live turn, and a direct context-manager append there would store
      // the notice out of order. Targets the primary agent; connectome-host
      // runs trunk-only, so this is the delivering agent in practice.
      this.addMessage('user', [{ type: 'text', text }], { system: true, kind: 'channel-notice' });
      console.error(`[channel] auto-open notice (${cause}) -> ${agentName ?? 'primary'}: ${shown}`);
    } catch (err) {
      console.error('recordChannelAutoOpenNotice failed:', err);
    }
  }

  /**
   * Explicit-prose-routing delivery gateway (docs/explicit-prose-routing.md).
   * Every prose segment of an `explicit`-mode agent flows through here:
   * parse the `>>` prefix, resolve the target, deliver — or bounce to the
   * clipboard with a resend notice. Misdelivery is structurally impossible:
   * nothing is ever sent to a destination the model did not name (directly
   * or via the turn's sticky target).
   */
  private async deliverProse(agent: Agent, rawText: string): Promise<void> {
    // Multi-envelope: a single prose block may address SEVERAL destinations —
    // every line beginning with `>>` opens a new envelope, routed
    // independently (first live use: Tilde 2026-07-24, one block carrying a
    // letter to #tilde-mythos AND a `>>#tilde` aside; the single-envelope
    // parser delivered the aside literally into the first destination —
    // exactly the leak class this mode exists to kill). Text before the
    // first `>>` is its own unprefixed envelope (sticky/bounce as usual).
    const lines = rawText.split('\n');
    const envelopes: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      // Only a REAL prefix line opens an envelope: `>>` immediately followed
      // by a target token. A quoted `>> arrow` (space after) stays body text.
      if (/^>>\S/.test(line.trimStart()) && current.length > 0) {
        envelopes.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) envelopes.push(current.join('\n'));

    for (const envelope of envelopes) {
      if (!envelope.trim()) continue;
      await this.deliverProseEnvelope(agent, envelope.replace(/^\s+(?=>>)/, ''));
    }
  }

  /** Locus-preserving explicit publication. Source remains byte-identical in Chronicle. */
  private async deliverHybridProse(
    agent: Agent,
    rawText: string,
    locus: string | null,
    allowLocus: boolean,
  ): Promise<void> {
    const lines = rawText.split('\n');
    const envelopes: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.trimStart().startsWith('>>>') && current.length > 0) {
        envelopes.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) envelopes.push(current.join('\n'));

    for (const envelope of envelopes) {
      if (!envelope.trim()) continue;
      const normalized = envelope.replace(/^\s+(?=>>>)/, '');
      const attempted = normalized.startsWith('>>>');
      const parsed = parseHybridProsePrefix(normalized);
      if (parsed.continueTurn) this.proseContinuations.add(agent.name);
      if (parsed.kind === 'private') {
        this.proseTargetPins.delete(agent.name);
        this.proseHybridSuppressed.add(agent.name);
        console.error(`[prose] ${agent.name}: >>>skip_reply — ${parsed.body.length} chars kept in context (not sent)`);
        continue;
      }
      if (parsed.kind === 'target') {
        const resolved = this.channelRegistry!.resolveProseTarget(parsed.target!);
        if ('error' in resolved) {
          this.proseTargetPins.delete(agent.name);
          this.proseHybridSuppressed.add(agent.name);
          this.bounceProse(agent, parsed.body, resolved.error, resolved.candidates, '>>>');
          continue;
        }
        let body = parsed.body;
        const usedClipboard = body.includes('{{unsent}}');
        if (usedClipboard) body = body.replaceAll('{{unsent}}', this.proseClipboards.get(agent.name) ?? '');
        this.proseTargetPins.set(agent.name, resolved.channelId);
        this.proseHybridSuppressed.delete(agent.name);
        if (!body.trim()) {
          console.error(`[prose] ${agent.name}: >>>${parsed.target} established target; empty body — nothing sent yet`);
          continue;
        }
        try {
          const outcome = await this.channelRegistry!.routeSpeech(agent.name, body, resolved.channelId);
          this.recordProseDelivery(agent.name, outcome);
          if (outcome?.delivered) {
            this.proseBounceStreaks.delete(agent.name);
            if (usedClipboard) this.proseClipboards.delete(agent.name);
          } else {
            this.proseTargetPins.delete(agent.name);
            this.proseHybridSuppressed.add(agent.name);
            this.bounceProse(agent, parsed.body, `delivery to ${resolved.channelId} was not confirmed`, undefined, '>>>');
          }
        } catch (err) {
          this.proseTargetPins.delete(agent.name);
          this.proseHybridSuppressed.add(agent.name);
          this.bounceProse(agent, parsed.body, `delivery to ${resolved.channelId} failed: ${err instanceof Error ? err.message : String(err)}`, undefined, '>>>');
        }
        continue;
      }
      if (attempted) {
        this.proseTargetPins.delete(agent.name);
        this.proseHybridSuppressed.add(agent.name);
        this.bounceProse(agent, normalized, 'malformed >>> routing envelope: destination is missing', undefined, '>>>');
        continue;
      }
      if (this.proseHybridSuppressed.has(agent.name)) {
        this.recordProseSuppression(agent.name, 1);
        continue;
      }
      const sticky = this.proseTargetPins.get(agent.name);
      if (!allowLocus && !sticky) {
        this.recordProseSuppression(agent.name, 1);
        continue;
      }
      const target = sticky ?? locus;
      try {
        const outcome = await this.channelRegistry!.routeSpeech(agent.name, envelope, target);
        this.recordProseDelivery(agent.name, outcome);
      } catch (err) {
        console.error('hybrid locus delivery failed:', err);
      }
    }
  }

  private async deliverProseEnvelope(agent: Agent, rawText: string): Promise<void> {
    const name = agent.name;
    const parsed = parseProsePrefix(rawText);
    if (parsed.continueTurn) this.proseContinuations.add(name);

    if (parsed.kind === 'private') {
      // The text already lives in the assistant message (window/chronicle);
      // "delivery" is deliberately a no-op. Consumes the retained text if the
      // segment embedded it.
      if (parsed.body.includes('{{unsent}}')) this.proseClipboards.delete(name);
      console.error(`[prose] ${name}: >>skip_reply — ${parsed.body.length} chars kept in context (not sent)`);
      return;
    }

    let targetChannel: string;
    let body: string;
    if (parsed.kind === 'target') {
      const res = this.channelRegistry!.resolveProseTarget(parsed.target!);
      if ('error' in res) {
        this.bounceProse(agent, parsed.body, res.error, res.candidates);
        return;
      }
      targetChannel = res.channelId;
      // Sticky within the turn: later unprefixed segments follow this target.
      this.proseTargetPins.set(name, targetChannel);
      body = parsed.body;
    } else {
      const sticky = this.proseTargetPins.get(name);
      if (!sticky) {
        this.bounceProse(agent, rawText, 'no destination prefix and no destination set yet this turn');
        return;
      }
      targetChannel = sticky;
      body = rawText;
    }

    const usedClipboard = body.includes('{{unsent}}');
    if (usedClipboard) {
      body = body.replaceAll('{{unsent}}', this.proseClipboards.get(name) ?? '');
    }
    if (!body.trim()) {
      console.error(`[prose] ${name}: empty body after prefix/substitution — nothing to send`);
      return;
    }

    try {
      const result = await this.channelRegistry!.routeSpeech(name, body, targetChannel);
      if (result?.delivered) {
        this.proseBounceStreaks.delete(name);
        if (usedClipboard) this.proseClipboards.delete(name);
      }
    } catch (err) {
      console.error(`[prose] ${name}: delivery to ${targetChannel} failed:`, err);
    }
  }

  /** Cap on consecutive bounce-triggered wakes (notices still append after). */
  private static readonly PROSE_BOUNCE_WAKE_CAP = 2;

  private bounceProse(agent: Agent, text: string, reason: string, candidates?: string[], prefix: '>>' | '>>>' = '>>'): void {
    const name = agent.name;
    this.proseClipboards.set(name, text);
    const streak = (this.proseBounceStreaks.get(name) ?? 0) + 1;
    this.proseBounceStreaks.set(name, streak);
    const cand = candidates?.length ? ` Known channels it could mean: ${candidates.join(', ')}.` : '';
    const notice =
      `[prose-routing] Your text (${text.length} chars) was not delivered — ${reason}.${cand} ` +
      'The text is retained; nothing is lost. To deliver it unchanged, reply with a ' +
      `destination plus the token {{unsent}}, e.g. "${prefix}#channel {{unsent}}" or "${prefix}@person {{unsent}}". ` +
      `"${prefix}skip_reply {{unsent}}" keeps it in context only.` +
      (prefix === '>>' ? ' The prose_help tool shows the full syntax.' : '');
    try {
      // Through framework.addMessage, NOT the context manager directly: while
      // the turn is still streaming this defers the notice to the next tool
      // boundary, where it is BOTH stored in order and injected into the live
      // stream (hear-while-acting) — the model sees the error and can correct
      // the prefix within the same turn. A direct append here would land the
      // notice before the turn's assistant blocks (cache bust, invisible
      // until the next compile).
      const id = this.addMessage(
        'user',
        [{ type: 'text', text: notice }],
        { system: true, kind: 'prose-bounce' },
      );
      if (id) this.emitTrace({ type: 'message:added', messageId: id, source: 'prose-bounce' });
      else this.emitTrace({ type: 'message:added', messageId: 'deferred', source: 'prose-bounce' });
    } catch (err) {
      console.error('bounceProse: failed to record bounce notice:', err);
    }
    const capped = streak > AgentFramework.PROSE_BOUNCE_WAKE_CAP;
    console.error(
      `[prose] ${name}: BOUNCED ${text.length} chars — ${reason}` +
      (capped ? ' (bounce-wake cap reached; notice appended without wake)' : ''),
    );
    if (!capped) {
      // Wake so the resend can happen immediately — an unsent DM reply must
      // not sit invisible until the next unrelated event.
      this.pendingRequests.push({
        agentName: name,
        reason: 'prose-bounce',
        source: 'framework',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * One-time mode primer (docs/explicit-prose-routing.md): when an agent's
   * configured proseRouting differs from the last mode we primed them for,
   * append the teaching notice and persist the new mode. A brand-new agent
   * in default locus mode is recorded silently — no primer for the status quo.
   */
  private maybePrimeProseMode(agent: Agent): void {
    const mode = agent.proseRouting;
    try {
      const data = this.store.getStateJson(FRAMEWORK_STATE_ID);
      const state = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const primed = { ...((state.proseRoutingPrimed as Record<string, string> | undefined) ?? {}) };
      const stored = primed[agent.name];
      if (stored === mode) return;
      // Absence means "always default (locus)": a locus-mode agent that was
      // never explicit needs no entry and no primer — and skipping the write
      // keeps framework/state from growing a record per agent (scaling gate).
      if (mode === 'locus' && stored === undefined) return;
      if (mode === 'locus') delete primed[agent.name];
      else primed[agent.name] = mode;
      state.proseRoutingPrimed = primed;
      this.store.setStateJson(FRAMEWORK_STATE_ID, state);
    } catch (err) {
      console.error('maybePrimeProseMode: state read/write failed:', err);
      return;
    }
    // Disabled mode is intentionally silent: no model-visible routing prose.
    // The resident publishes only through explicit tools. This contains
    // continuity-summary locus leaks (Host #96).
    if (mode === 'disabled') {
      console.error(`[prose] ${agent.name}: disabled mode recorded (no primer injected)`);
      return;
    }
    try {
      const id = agent.getContextManager().addMessage(
        'user',
        [{ type: 'text', text: proseModePrimer(mode) }],
        { system: true, kind: 'prose-routing-primer' },
      );
      this.emitTrace({ type: 'message:added', messageId: id, source: 'prose-routing-primer' });
      console.error(`[prose] ${agent.name}: mode primer appended (${mode})`);
    } catch (err) {
      console.error('maybePrimeProseMode: failed to append primer:', err);
    }
  }

  private async startAgentStream(
    agent: Agent,
    trigger?: InferenceRequest,
    attempt = 0,
    providerGateAlreadyHeld = false,
  ): Promise<void> {
    const ownsProviderGate =
      !this.ephemeralRuns.has(agent.name) && !this.conversationAgentHomes.has(agent.name);
    if (ownsProviderGate && !providerGateAlreadyHeld) {
      this.acquirePrimaryProviderGate(agent.name);
      const gate = this.providerGate(agent.name);
      if (gate.auxiliaryInFlight > 0) {
        // Do not await inside processInferenceRequests: one slow auxiliary call for
        // this resident must not block events or other residents. Admission stays
        // owned and the continuation receives it after the in-flight call settles.
        void this.waitForAuxiliaryIdle(agent.name).then(async () => {
          if (this.providerAdmissionClosed) {
            this.releasePrimaryProviderGate(agent.name);
            return;
          }
          await this.startAgentStream(agent, trigger, attempt, true);
        }).catch((error) => {
          this.releasePrimaryProviderGate(agent.name);
          console.error(`[provider-cooldown] failed to resume primary for ${agent.name}:`, error);
        });
        return;
      }
      if (this.providerAdmissionClosed) {
        this.releasePrimaryProviderGate(agent.name);
        return;
      }
    }
    // Mark the turn alive before ANYTHING awaits (hooks, compile, stream
    // setup): from here until this turn's teardown, cross-turn writers defer
    // (addMessage guard) instead of appending — nothing may enter the window
    // between a turn's dequeue and its settle except the turn's own blocks.
    // A retry re-enters with a fresh token; teardown clears token-matched.
    //
    // The try/finally is the leak-proofing: a token whose owner never clears
    // it permanently requeues every wake for the agent (the 'idle+turn-alive'
    // wedge — worse than any single lost turn). Ownership is handed off
    // exactly once, to driveStream, the moment the stream handle is
    // registered; on every other exit — including a throw from the turn-start
    // flush, recordTurnCheckpoint, or locus resolution, none of which the
    // inner catch covers (ENOSPC-class store writes live there) — the finally
    // clears our own token. Token-matched, so when a retry frame has replaced
    // the token, or the terminal-failure branch already deleted it, this
    // no-ops instead of clobbering a successor's marker.
    const turnToken = this.nextTurnToken++;
    this.activeTurnTokens.set(agent.name, turnToken);
    let tokenHandedOff = false;
    try {
      tokenHandedOff = await this.beginAgentTurn(agent, trigger, attempt, turnToken, ownsProviderGate);
    } finally {
      if (!tokenHandedOff && this.activeTurnTokens.get(agent.name) === turnToken) {
        this.activeTurnTokens.delete(agent.name);
      }
      if (!tokenHandedOff && ownsProviderGate) this.releasePrimaryProviderGate(agent.name);
    }
  }

  /**
   * Body of startAgentStream, split out so the caller's try/finally owns the
   * turn token unconditionally. Returns true iff the token was handed off to
   * driveStream (whose finally then owns clearing it).
   */
  private async beginAgentTurn(
    agent: Agent,
    trigger: InferenceRequest | undefined,
    attempt: number,
    turnToken: number,
    ownsProviderGate: boolean,
  ): Promise<boolean> {
    // Flush messages deferred during the PREVIOUS turn — before the
    // checkpoint, the locus announcement, and the compile — so a turn started
    // by a queued wake actually CONTAINS the message that woke it. (2026-07-31
    // Mythos: a DM's wake fired a turn whose compile ran before the deferred
    // DM flushed; the model saw only the routing-shift notice, reasonably
    // skipped, and the DM then landed before the skip in the window — false
    // "saw it and ignored it" history plus KV divergence. Flushed here, the
    // payload rides its own wake, and the notice/payload can never split.)
    // Primary agent only — deferred messages are framework-level, meant for
    // the main conversation (same target rule as the tool-boundary flush).
    // Fresh turns only: a context-budget restart continues the same logical
    // turn, and flushing there would insert messages between its rounds.
    // Before recordTurnCheckpoint: these are the turn's inputs, not its
    // products — undoing the turn must not destroy them.
    if (
      attempt === 0 &&
      trigger?.reason !== 'context_budget_restart' &&
      this.deferredMessages.length > 0
    ) {
      const target = (this.primaryAgentName ? this.agents.get(this.primaryAgentName) : undefined) ?? agent;
      if (target === agent) {
        const deferred = this.deferredMessages.splice(0);
        for (const msg of deferred) {
          // Per-message try/catch (mirrors announceLocusIfChanged): one
          // poison message — or a transient store-write failure — must not
          // abort the turn or drop the messages behind it in the queue.
          try {
            const id = agent.getContextManager().addMessage(msg.participant, msg.content, msg.metadata);
            this.emitTrace({ type: 'message:added', messageId: id, source: 'deferred-flush:turn-start' });
          } catch (err) {
            console.error(
              `[deferred-flush] turn-start flush failed to store a message for ${agent.name} ` +
              `(participant=${msg.participant}):`,
              err,
            );
          }
        }
      }
    }

    // Record turn checkpoint before inference (only on first attempt, not retries)
    if (attempt === 0) {
      this.recordTurnCheckpoint(agent.name);
      this.redoStacks.delete(agent.name); // new work invalidates redo
    }

    // Establish this turn's outbound routing locus (item-3 redux). Set it to the
    // triggering channel for a channel/DM-triggered turn; clear it otherwise so
    // a heartbeat / no-trigger turn doesn't inherit a previous turn's channel and
    // instead falls back to the global default. A given agent runs one turn at a
    // time, so a set here is only read during THIS turn's routeSpeech /
    // buildChannelContext; retries re-run with the same trigger, re-setting it.
    // A context-budget restart continues the SAME logical turn in a fresh
    // stream — its trigger carries no channelId, and deleting the trigger
    // channel here mid-logical-turn is exactly the hole that sent Sol's DM
    // reply to a stale guild channel (2026-07-22): any live locus resolution
    // after the restart fell through to the hours-old defaultPublishChannel.
    // Keep the turn's trigger channel across restarts; only real new turns
    // reset it.
    if (trigger?.reason !== 'context_budget_restart') {
      if (trigger?.channelId) {
        this.activeTriggerChannels.set(agent.name, trigger.channelId);
      } else {
        this.activeTriggerChannels.delete(agent.name);
      }
    }

    // FREEZE this turn's outbound locus now (turn-frozen routing). Resolved
    // once — home channel for forks, else the triggering channel, else the
    // global default — and never moved for the rest of the turn: mid-turn
    // injections must not redirect the agent's plain prose (ambient chatter /
    // reactions hijacked it before, 2026-07-21). A context-budget restart
    // continues the same logical turn, so it keeps the existing pin. The
    // eager snapshot also protects heartbeat turns from a moving
    // defaultPublishChannel mid-turn. If the effective locus differs from the
    // last one announced, drop a durable `[routing]` notice into the window
    // BEFORE this turn compiles, so the agent always knows where its voice
    // goes (announce-on-change only — no per-turn chatter, append-only for
    // KV stability).
    if (trigger?.reason !== 'context_budget_restart') {
      if (attempt === 0) this.maybePrimeProseMode(agent);
      // Fresh turn: forget the previous turn's explicit-send engagements and
      // prose deliveries — both are strictly turn-scoped (a restart continues
      // the same logical turn and keeps them).
      this.turnEngagedChannels.delete(agent.name);
      this.turnProseDeliveries.delete(agent.name);
      this.turnProseSuppressed.delete(agent.name);
      this.proseHybridSuppressed.delete(agent.name);
      if (agent.proseRouting === 'hybrid') this.proseTargetPins.delete(agent.name);
      if (agent.proseRouting === 'explicit' || agent.proseRouting === 'disabled') {
        // Explicit and disabled prose routing have no inferred locus.
        // Explicit mode uses a turn-scoped `>>` target; disabled mode has no
        // prose target at all. Neither mode freezes or announces a locus.
        this.proseTargetPins.delete(agent.name);
        this.proseContinuations.delete(agent.name);
        this.midTurnInputSignals.delete(agent.name);
        this.turnLocusPins.delete(agent.name);
      } else {
        const locus = this.channelRegistry?.resolveLocus(agent.name) ?? null;
        if (locus !== null) this.turnLocusPins.set(agent.name, locus);
        else this.turnLocusPins.delete(agent.name);
        this.midTurnInputSignals.delete(agent.name);
        if (attempt === 0) this.announceLocusIfChanged(agent.name, locus);
      }
    }

    this.touchEphemeralRun(agent.name, true);
    this.emitTrace({
      type: 'inference:started',
      agentName: agent.name,
      // The turn-frozen locus was pinned just above (kept across a
      // context-budget restart, which skips the re-pin but re-emits this).
      channelId: this.turnLocusPins.get(agent.name),
    });
    this.eventGate?.onInferenceStarted(agent.name);
    this.lastInferenceAt.set(agent.name, { ...this.lastInferenceAt.get(agent.name), startedAt: Date.now() });

    // Typing indicator, started at TURN START. It says "attending", which is
    // true from the moment the turn is accepted — but it used to start inside
    // driveStream, i.e. only after module gatherContext + MCPL beforeInference
    // RPCs + the full context compile + stream initiation. All of that read as
    // dead air to whoever just messaged the agent (30+ s during the 2026-07
    // mythos compile regression; still seconds of hooks+compile after).
    // Same channel choice as driveStream's own startTyping (which stays, is
    // idempotent per channel, and owns the 7s refresh); the catch below stops
    // it on the no-driveStream failure paths (e.g. a compile refusal).
    const earlyTypingChannel =
      agent.proseRouting === 'explicit'
        ? trigger?.channelId ?? null
        : this.turnLocusPins.get(agent.name) ?? null;
    if (earlyTypingChannel) this.channelRegistry?.startTyping(earlyTypingChannel);

    try {
      const requestSnapshot = this.captureInferenceToolSnapshot(agent);
      const allTools = this.getToolsForAgent(agent.name, requestSnapshot);
      const tools = allTools.filter((t) => agent.canUseTool(t.name));
      // Explicit-mode agents get the on-demand routing reference (teach-by-
      // bounce: the grammar is never injected, only served when asked).
      if (agent.proseRouting === 'explicit') tools.push(PROSE_HELP_TOOL);

      // Gather context from modules (pull-based) and MCPL hooks (push-based)
      // Both produce ContextInjection[] that get merged before inference.
      let injections: ContextInjection[] | undefined;

      // Module gatherContext (fail-open, per-module timeout — the module's
      // contextTimeoutMs, else the registry default). Injections are
      // channel-scoped via scopeInjectionsForAgent, matching the MCPL hook
      // injections below, so conversation forks don't see cross-channel
      // content.
      try {
        const moduleInjections = this.scopeInjectionsForAgent(
          agent.name,
          await this.moduleRegistry.gatherContext(agent.name),
        );
        if (moduleInjections.length > 0) {
          injections = moduleInjections;
        }
      } catch (error) {
        console.error('Module gatherContext error:', error);
      }

      // MCPL beforeInference hooks (fail-open)
      if (this.hookOrchestrator) {
        try {
          const hookParams = this.buildBeforeInferenceParams(agent, trigger);
          const hookInjections = this.scopeInjectionsForAgent(
            agent.name,
            await this.hookOrchestrator.beforeInference(hookParams),
          );
          if (hookInjections.length > 0) {
            injections = injections ? [...injections, ...hookInjections] : hookInjections;
          }
        } catch (error) {
          console.error('beforeInference hook error:', error);
        }
      }

      const { stream, request: compiledRequest } = await agent.startStreamWithInjections(tools, injections);

      const handle = this.driveStream(
        agent,
        stream,
        requestSnapshot,
        trigger,
        attempt,
        compiledRequest,
        ownsProviderGate,
      );
      this.activeStreams.set(agent.name, handle);
      // Handoff: driveStream captured the token in its synchronous prefix;
      // its finally now owns clearing it. The caller's finally must not.
      return true;
    } catch (error) {
      // The early typing indicator has no driveStream `finally` on this path —
      // a hook/compile/stream-setup failure must not leave "typing…" stuck.
      // (Retries below restart it; stopTyping is idempotent.)
      this.channelRegistry?.stopTyping();
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitTrace({
        type: 'inference:failed',
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
      });
      agent.reset();

      if (ownsProviderGate && this.holdProviderAcceleration(agent, err, trigger)) {
        // Capacity scheduling is not poisoned history. The cooldown timer owns
        // one later fresh compile; no immediate retry or exhaustion marker.
        this.eventGate?.onInferenceEnded(agent.name);
        return false;
      }

      const action = this.errorPolicy.onInferenceError(err, agent.name, attempt);
      if (action.retry) {
        await new Promise((resolve) => setTimeout(resolve, action.delayMs));
        // The retry re-enters startAgentStream, which replaces this frame's
        // turn token with its own; cleanup belongs to the innermost frame.
        await this.startAgentStream(agent, trigger, attempt + 1);
      } else {
        // Terminal failure with no driveStream: this frame owns teardown.
        // Token-matched (like the finally in driveStream) so a stale frame
        // can never clear a successor turn's marker. A leaked token would
        // permanently requeue every wake for this agent (same wedge shape as
        // the eventGate `inferring` leak) — every exit path must clear it.
        if (this.activeTurnTokens.get(agent.name) === turnToken) {
          this.activeTurnTokens.delete(agent.name);
        }
        this.settleAgent(agent.name, {
          stopReason: 'exhausted',
          speech: '',
          error: err.message,
        });
        this.emitTrace({
          type: 'inference:exhausted',
          agentName: agent.name,
          error: err.message,
          // Drives the poison-history breaker (`invalid_request`: a 400-class
          // rejection of the history itself — retrying the same context can
          // never succeed; auth/abort/context_length are also non-retryable
          // but must NOT cost history) and the OverBudget drain breaker
          // (`over_budget`: compile refused to fit the hard budget — this is
          // the site that sees it, since compile runs before the stream
          // exists). `retryable` is kept for observability.
          ...this.classifyInferenceError(err),
        });
        this.eventGate?.onInferenceEnded(agent.name);
        if (action.emit) {
          this.pushEvent(action.emit);
        }
      }
      // No handoff on either failure branch: the terminal branch deleted the
      // token above; the retry branch's recursive startAgentStream replaced
      // it with the inner frame's token. Returning false lets the caller's
      // token-matched finally no-op in both cases (and actually clear it if
      // something above threw before either branch ran).
      return false;
    }
  }

  private async driveStream(
    agent: Agent,
    stream: YieldingStream,
    requestSnapshot: InferenceToolSnapshot,
    trigger?: InferenceRequest,
    attempt = 0,
    compiledRequest?: NormalizedRequest,
    ownsProviderGate = false,
  ): Promise<void> {
    const startTime = Date.now();
    const requestId = `${agent.name}-${startTime}-${Math.random().toString(36).slice(2, 8)}`;
    const myStreamId = agent.streamId;
    // This turn's alive-marker, set at startAgentStream entry. Safe to read
    // from the map here: the turn-alive busy check in processInferenceRequests
    // means no successor turn can have replaced it while we compiled.
    const myTurnToken = this.activeTurnTokens.get(agent.name);
    let hadToolCalls = false;

    // ---- Present-while-acting turn state ---------------------------------
    // Output locus for the WHOLE logical turn: frozen in startAgentStream
    // (home → addressed trigger → global default) before this stream began,
    // and never moved until the next turn. Mid-turn injections do not touch
    // it — an ambient message or a reaction arriving at a tool boundary must
    // not redirect the agent's task narration (2026-07-21 Cairn misroute).
    // The pin lives in `turnLocusPins` so a context-budget restart (same
    // logical turn, fresh driveStream) keeps it.
    const resolveTurnLocus = (): string | null =>
      this.turnLocusPins.get(agent.name) ?? null;

    // Ordered delivery chain for live-routed prose. Links are enqueued
    // WITHOUT awaiting in the stream-event loop — an awaited network post
    // here would stall consumption of the next round's events by
    // segments × RTT on every prose-bearing round. The 'complete' case
    // awaits the chain before routing trailing prose, so in-channel ordering
    // is preserved end-to-end. Each link catches its own error: one failed
    // post must not silence the rest of the turn.
    let turnSpeechChain: Promise<void> = Promise.resolve();
    const enqueueSpeech = (text: string, locus: string | null): void => {
      turnSpeechChain = turnSpeechChain
        .then(async () => {
          const outcome = await this.channelRegistry!.routeSpeech(agent.name, text, locus);
          this.recordProseDelivery(agent.name, outcome);
        })
        .catch((err) => console.error('mid-turn speech routing failed:', err));
    };

    // Sticky explicit-send suppression: prose after send_message stays quiet
    // to prevent a redundant "sent it" postscript. Fresh injected input
    // clears it, because the following prose is a reply to a new message.
    let turnSilenced = false;

    // Live routing is only trusted when the membrane provides verbatim
    // round-scoped blocks (roundContent, native tool mode, membrane ≥0.5.64).
    // The fallback `preamble` is CUMULATIVE in XML mode (assistant prefill +
    // all earlier rounds' prose and raw tool/thinking XML) — live-routing it
    // would repost the transcript and leak thinking every round. When no
    // round was live-routed, the 'complete' case falls back to the
    // historical whole-turn routing so fallback-mode prose is still
    // delivered exactly once, at turn end.
    let liveProseRouting = false;

    // Typing indicator: show "<agent> is typing…" for the whole duration of
    // this turn. Started here (paired with the finally below, so it can never
    // leak) and refreshed on a 7s interval by the ChannelRegistry until
    // stopped on any exit path. Never moves mid-turn.
    //   - locus mode: the frozen routing pin (where bare prose will land).
    //   - explicit mode: there is no locus — indicate on the TRIGGER channel
    //     (where the wake came from). Typing is presence, not delivery, so
    //     this doesn't violate never-guess: it says "attending to what you
    //     sent here", which is true regardless of where the reply goes.
    //     Heartbeat/no-trigger explicit turns show no indicator.
    const typingChannel =
      agent.proseRouting === 'disabled'
        ? null
        : agent.proseRouting === 'explicit'
          ? trigger?.channelId ?? null
          : resolveTurnLocus();
    if (typingChannel) this.channelRegistry!.startTyping(typingChannel);

    // MCPL Spec 14.3 outgoing streaming: route text deltas to their
    // destination server AS THEY GENERATE (voice synthesis, live message
    // rendering). Pure observer surface — suppression is fail-closed (nothing
    // streams that delivery would refuse), emission is capability-gated in
    // the registry (`channels.streaming`), and delivery via deliverProse
    // remains the sole authoritative send.
    const newOutgoingInferenceId = (): string =>
      `inf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // NOT const: a membrane refusal retry abandons everything streamed so
    // far, and the surface must not concatenate two attempts. Re-minting the
    // id makes the discarded attempt's chunk buffer orphaned (never
    // finalized) instead of being appended to — see the 'retrying' case.
    let outgoingInferenceId = newOutgoingInferenceId();
    let outgoingIndex = 0;

    // §10.5 inference/lifecycle: `started` now, exactly one terminal in the
    // finally below (the one block every exit path shares). Which terminal
    // is decided by the paths themselves: default completed, catch sets
    // failed, a framework-cancelled stream sets aborted. Best-effort
    // notifications — consumers dedupe by inferenceId and keep a timeout.
    let lifecyclePhase: 'completed' | 'aborted' | 'failed' = 'completed';
    this.hookOrchestrator?.emitLifecycle({
      inferenceId: outgoingInferenceId,
      conversationId: agent.name,
      turnIndex: 0,
      phase: 'started',
    });
    const proseStream = this.channelRegistry && agent.proseRouting !== 'disabled'
      ? new ProseStreamRouter({
          mode: agent.proseRouting === 'explicit' ? 'explicit' : agent.proseRouting === 'hybrid' ? 'hybrid' : 'locus',
          initialTarget: typingChannel,
          resolve: (spec) => {
            const r = this.channelRegistry!.resolveProseTarget(spec);
            return 'channelId' in r ? r.channelId : null;
          },
        })
      : null;
    const emitOutgoing = (deltas: { channelId: string; delta: string }[]): void => {
      for (const rd of deltas) {
        this.channelRegistry!.sendOutgoingChunk(
          rd.channelId, agent.name, outgoingInferenceId, outgoingIndex++, rd.delta,
        );
      }
    };

    const adoptInjectedRound = (): void => {
      if (!this.midTurnInputSignals.has(agent.name)) return;
      this.midTurnInputSignals.delete(agent.name);

      // A new conversational message, not merely a tool result, means any
      // earlier explicit delivery has completed its conversational job.
      // Routing is NOT touched: the turn locus stays frozen.
      turnSilenced = false;
    };

    try {
      for await (const event of stream) {
        this.touchEphemeralRun(agent.name, true);
        switch (event.type) {
          case 'tokens':
            this.emitTrace({
              type: 'inference:tokens',
              agentName: agent.name,
              content: event.content,
              blockType: event.meta.type,
              blockIndex: event.meta.blockIndex,
              // Turn-frozen locus (same value as the typing indicator above):
              // lets trace consumers tag every chunk with the channel this
              // turn's prose is bound for, without re-deriving routing.
              channelId: typingChannel ?? undefined,
            });
            if (proseStream && event.meta.type === 'text') {
              emitOutgoing(proseStream.feed(event.content));
            }
            break;

          case 'retrying': {
            // Membrane is re-issuing after a content-policy refusal. Per the
            // RetryingEvent contract we must DISCARD everything this call has
            // emitted: the tokens above were already streamed to the surface
            // as outgoing chunks, and appending a second attempt to them
            // would show the human two half-answers spliced together.
            //
            // Re-mint the outgoing id so the partial buffer is orphaned
            // rather than continued (delivery is authoritative via
            // deliverProse and has not happened yet — nothing has been
            // *sent*, only previewed), and reset the prose router so its
            // destination bookkeeping starts clean for the new attempt.
            console.error(
              `[refusal-retry] agent=${agent.name} membrane retry ` +
                `${event.attempt}/${event.maxAttempts}` +
                (event.category ? ` category=${event.category}` : '') +
                ' — discarding the refused attempt',
            );
            outgoingInferenceId = newOutgoingInferenceId();
            outgoingIndex = 0;
            proseStream?.reset();
            this.emitTrace({
              type: 'inference:tokens',
              agentName: agent.name,
              content: '',
              blockType: 'text',
              blockIndex: 0,
              channelId: typingChannel ?? undefined,
            });
            break;
          }

          case 'block': {
            const { event: phase, index, block } = event.event;
            this.emitTrace({
              type: 'inference:content_block',
              agentName: agent.name,
              phase,
              blockType: block.type,
              blockIndex: index,
              channelId: typingChannel ?? undefined,
            });
            break;
          }

          case 'tool-calls': {
            adoptInjectedRound();
            hadToolCalls = true;
            this.recordEphemeralToolCalls(agent.name, event.calls.length);
            this.emitTrace({
              type: 'inference:tool_calls_yielded',
              agentName: agent.name,
              calls: event.calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
            });

            // Build assistant content blocks for this round. Prefer the
            // membrane's verbatim round content (membrane ≥0.5.64): it
            // preserves native thinking / redacted_thinking blocks with
            // their signatures IN ORDER — the API requires signed thinking
            // to precede its tool_use in the same assistant turn, so
            // rebuilding from preamble + calls would break thinking+tools.
            const roundContent = (event.context as { roundContent?: ContentBlock[] }).roundContent;
            let assistantBlocks: ContentBlock[];
            if (roundContent && roundContent.length > 0) {
              assistantBlocks = roundContent.filter(
                (b) => b.type !== 'tool_result'
              );
            } else {
              // Fallback (older membrane / XML tool mode): preamble + calls.
              // XML mode: persist the verbatim generation on each tool_use
              // (membrane#36 round-trip fidelity). context.rawText is the
              // parser's fullMatch — the exact <function_calls> block the
              // model wrote (plus the harness-appended close tag), shared by
              // every call in the round; the anthropic-xml formatter replays
              // it byte-identically instead of reconstructing. Guarded by
              // shape so a native-path fallback can never attach non-XML.
              const rawText = event.context.rawText;
              const rawXml = rawText && /^<(antml:)?function_calls>/.test(rawText)
                ? rawText
                : undefined;
              // Persist THIS round's text only. `roundPreamble` (membrane
              // ≥0.5.79) is the per-round delta; the legacy `preamble` is
              // CUMULATIVE in XML mode — persisting it per round stored each
              // round's text N times and re-persisted injected
              // <function_results> as the agent's own words (the Evander
              // 2026-08-08 scaffold-leak pyramid: r1 ×3, r2 ×2).
              const roundText =
                (event.context as { roundPreamble?: string }).roundPreamble ??
                event.context.preamble;
              assistantBlocks = [];
              if (roundText) {
                assistantBlocks.push({ type: 'text', text: roundText });
              }
              for (const c of event.calls) {
                assistantBlocks.push({
                  type: 'tool_use',
                  id: c.id,
                  name: c.name,
                  input: c.input as Record<string, unknown>,
                  ...(rawXml ? { rawXml } : {}),
                });
              }
            }
            this.pendingAssistantBlocks.set(agent.name, assistantBlocks);

            // Note: max_tokens truncation cannot produce tool-calls events here.
            // The membrane only yields 'tool-calls' when stop_reason is 'tool_use'
            // (native API) or the closing </function_calls> tag is found (text parser).
            // Truncated responses yield 'complete' with stop_reason 'max_tokens' directly.
            // So all calls here have valid input — {} is legitimate for parameterless tools.

            agent.enterWaitingForTools(event.calls, stream);

            for (const call of event.calls) {
              this.dispatchToolCall(agent.name, call);
            }

            // Speak-while-acting: route THIS round's prose to the locus NOW
            // instead of batching every segment to the end of the turn. Long
            // tool-using turns (robot control, live sessions) otherwise dump
            // the whole narration in one blob when the turn finally settles —
            // and, worse, make "talking" and "acting" feel mutually exclusive
            // to the agent. Mid-turn prose is speech (delivered live, in
            // order, via the turn's speech chain — never awaited here); the
            // `think` tool remains the private channel. Silencing is STICKY
            // from the round it occurs (see SILENCING_TOOLS). Only rounds
            // with verbatim roundContent are live-routed (see liveProseRouting
            // note above — the fallback preamble is cumulative in XML mode).
            if (this.channelRegistry) {
              const roundToolNames = event.calls.map((c) => c.name);
              const hasSameRoundPrivateThink =
                roundToolNames.includes('think') &&
                requestSnapshot.sameRoundThinkTextPolicy === 'private';
              if (roundToolNames.some((n) =>
                SILENCING_TOOLS.has(bareToolName(n)) ||
                (agent.proseRouting === 'hybrid' && HYBRID_PUBLICATION_TOOLS.has(bareToolName(n)))
              )) {
                turnSilenced = true;
              }
              if (roundContent && roundContent.length > 0) {
                liveProseRouting = true;
                const roundSegments = splitProseSegments(assistantBlocks);
                if (roundSegments.length > 0) {
                  if (agent.proseRouting === 'disabled') {
                    console.error(
                      `[routing] ${agent.name}: mid-turn prose NOT routed (proseRouting=disabled)`,
                    );
                    this.recordProseSuppression(agent.name, roundSegments.length);
                  } else if (agent.proseRouting === 'hybrid') {
                    if (turnSilenced) {
                      this.recordProseSuppression(agent.name, roundSegments.length);
                    } else if (!hasSameRoundPrivateThink) {
                      const locus = resolveTurnLocus();
                      for (const seg of roundSegments) {
                        turnSpeechChain = turnSpeechChain
                          .then(() => this.deliverHybridProse(agent, seg, locus, true))
                          .catch((err) => console.error('mid-turn hybrid prose delivery failed:', err));
                      }
                    }
                  } else if (agent.proseRouting === 'explicit') {
                    // Explicit mode: every segment through the prose gateway.
                    // Silencing does not apply — unprefixed prose bounces and
                    // prefixed prose is deliberate; think-privacy still holds.
                    if (!hasSameRoundPrivateThink) {
                      console.error(
                        `[prose] ${agent.name}: mid-turn round [${roundToolNames.join(', ')}] -> ${roundSegments.length} segment(s) via prose gateway`,
                      );
                      for (const seg of roundSegments) {
                        turnSpeechChain = turnSpeechChain
                          .then(() => this.deliverProse(agent, seg))
                          .catch((err) => console.error('mid-turn prose delivery failed:', err));
                      }
                    }
                  } else if (turnSilenced) {
                    console.error(
                      `[routing] ${agent.name}: mid-turn round [${roundToolNames.join(', ')}] -> prose NOT routed (turn silenced)`,
                    );
                    // Visible in the turn-end receipt — silencing must never
                    // be a silent black hole (n=8: the flying-scene reply).
                    this.recordProseSuppression(agent.name, roundSegments.length);
                  } else if (hasSameRoundPrivateThink) {
                    console.error(
                      `[routing] ${agent.name}: mid-turn round [${roundToolNames.join(', ')}] -> prose NOT routed (same_round_think_text_policy=private)`,
                    );
                  } else {
                    const locus = resolveTurnLocus();
                    console.error(
                      `[routing] ${agent.name}: mid-turn round [${roundToolNames.join(', ')}] -> routing ${roundSegments.length} prose segment(s) live -> ${locus ?? '(default)'}`,
                    );
                    for (const seg of roundSegments) {
                      enqueueSpeech(seg, locus);
                    }
                  }
                }
              }
            }
            // Stream's async iterator blocks on next() until provideToolResults() is called
            break;
          }

          case 'complete': {
            adoptInjectedRound();
            const durationMs = Date.now() - startTime;
            const response = event.response;

            // If the agent is still waiting_for_tools when 'complete' fires
            // (shouldn't happen after incomplete-tool-call fix, but guard anyway),
            // flush pending blocks + inject error results for any remaining pending tools.
            if (agent.state.status === 'waiting_for_tools') {
              console.warn(
                `[framework] 'complete' event fired while agent '${agent.name}' is still waiting_for_tools. ` +
                `Injecting error results for ${agent.getPendingToolIds().length} pending tool(s).`
              );
              // Inject error results for all remaining pending tools
              for (const pendingId of agent.getPendingToolIds()) {
                agent.provideToolResult(pendingId, {
                  success: false,
                  error: 'Stream completed before tool result was received (likely max_tokens truncation).',
                  isError: true,
                });
              }
              // Flush pending assistant blocks
              const pending = this.pendingAssistantBlocks.get(agent.name);
              if (pending) {
                agent.addAssistantResponse(pending);
                this.pendingAssistantBlocks.delete(agent.name);
              }
              // Store tool results — same bounded spill policy as the
              // ordinary path (issue #89: this guard path must not become the
              // one door a giant blob still walks through).
              const readyState = agent.state as AgentState;
              if (readyState.status === 'ready') {
                const { blocks: toolResultContent } = await this.buildStoredToolResultContent(
                  readyState.toolResults,
                  this.resolveToolResultInlineCap(agent).cap,
                );
                agent.getContextManager().addMessage('user', toolResultContent);
              }
            }

            // Add assistant response to context.
            // If we had tool calls, each round's blocks (thinking + text +
            // tool_use) were already stored as pendingAssistantBlocks and
            // flushed when tool results arrived. Only store TRAILING content
            // — blocks after the last tool block. A type-based filter would
            // double-store earlier rounds' text/thinking AND detach signed
            // thinking blocks from their tool_use turn (the API requires
            // thinking to precede tool_use in the same assistant turn).
            const lastToolIdx = response.content.reduce(
              (last: number, b: ContentBlock, i: number) =>
                b.type === 'tool_use' || b.type === 'tool_result' ? i : last,
              -1
            );
            const terminalContent = lastToolIdx >= 0
              ? response.content.slice(lastToolIdx + 1)
              : response.content;
            if (lastToolIdx >= 0) {
              if (terminalContent.length > 0) {
                agent.addAssistantResponse(terminalContent);
              }
            } else {
              agent.addAssistantResponse(terminalContent);
            }

            // Bind the cooldown receipt to this fresh, successful request —
            // never to the frozen request that received the 429.
            this.recordProviderAccelerationRecovery(agent, compiledRequest, response.stopReason);

            // §10.5: context/afterInference is removed in 0.5.0 — no
            // content leaves the host here. Turn boundaries are announced
            // by the metadata-only inference/lifecycle notifications
            // emitted in driveStream's start/exit paths.

            // Separate speech from thoughts — for MODULE dispatch only
            // (dispatchSpeech / TUI rendering below). This split does NOT
            // decide what reaches the channel: mid-turn prose is routed live
            // per round (see the 'tool-calls' case) and trailing prose is
            // routed after this block. On a tool-using turn the module-level
            // convention remains "text is thoughts"; on a text-only turn all
            // text is speech.
            const isTextBlock = (block: ContentBlock): block is ContentBlock & { type: 'text' } =>
              block.type === 'text';
            const allText = response.content.filter(isTextBlock);

            const speechContent = hadToolCalls ? [] : allText;
            const thoughts = hadToolCalls ? allText : [];

            const du = response.details?.usage;
            const tokenUsage = du
              ? {
                  input: du.inputTokens,
                  output: du.outputTokens,
                  cacheCreation: du.cacheCreationTokens,
                  cacheRead: du.cacheReadTokens,
                }
              : undefined;

            // Reset agent state before emitting inference:completed. Traces are
            // observability-only, but external synchronous listeners should
            // still see the terminal state at the terminal trace boundary.
            // Speech dispatch happens after but doesn't depend on the status
            // field.
            agent.reset();
            this.eventGate?.onInferenceEnded(agent.name);
            this.settleAgent(agent.name, {
              stopReason: 'completed',
              speech: terminalContent
                .filter((block: ContentBlock): block is ContentBlock & { type: 'text' } => block.type === 'text')
                .map((block) => block.text)
                .join('\n'),
            });

            this.emitTrace({
              type: 'inference:completed',
              agentName: agent.name,
              durationMs,
              tokenUsage,
            });

            if (du) {
              this.usageTracker.onInferenceCompleted(agent.name, {
                inputTokens: du.inputTokens,
                outputTokens: du.outputTokens,
                cacheCreationTokens: du.cacheCreationTokens,
                cacheReadTokens: du.cacheReadTokens,
              }, du.estimatedCost ? { total: du.estimatedCost.total, currency: du.estimatedCost.currency } : undefined);
              this.persistUsageState();
            }

            // Log inference
            this.logInference({
              timestamp: startTime,
              agentName: agent.name,
              requestId,
              success: true,
              request: compiledRequest ?? { note: 'streaming request' },
              response: response.raw ?? { note: 'streaming response' },
              durationMs,
              tokenUsage,
              stopReason: response.stopReason,
            });

            // Surface refusals instead of going silently mute: stderr line
            // (headless inference failures are otherwise under-logged) + an
            // emoji reaction on the triggering Discord message, keyed by the
            // refusal category from stop_details.
            if (response.stopReason === 'refusal') {
              // stop_details lives on the raw PROVIDER response
              // (response.raw is RawAccess = { request, response, headers }).
              const stopDetails = (response.raw?.response as {
                stop_details?: { category?: string; explanation?: string };
              } | undefined)?.stop_details;
              const category = stopDetails?.category ?? 'unknown';
              console.error(
                `[inference-refusal] agent=${agent.name} category=${category}` +
                  (stopDetails?.explanation ? ` explanation=${stopDetails.explanation}` : ''),
              );

              this.noteRefusal(agent.name, category, tokenUsage);

              // Rewind: excise the turn that fed the refusal, drop a
              // metadata-only marker, and retry — keeping the agent on its own
              // model instead of substituting a fallback. Driven either by an
              // admin `/unstick` (forced session) or the agent's autoRewind
              // config; both are bounded.
              let handledByRewind = false;
              const rh = agent.refusalHandling;
              const forced = this.forcedRewind.get(agent.name);

              // NOTE: plain retries are NOT done here. `refusalHandling.retries`
              // is handed to membrane (see Agent.startActivation), which
              // replays the SAME request at the provider seam — immediately,
              // cache-warm, and without recompiling into a different window.
              // A framework-level requeue was tried first and is strictly
              // worse: it recompiles, so attempts are correlated rather than
              // fresh draws against a probabilistic threshold, and it cannot
              // tell a streaming consumer to discard the abandoned attempt.
              // By the time a refusal reaches here, membrane's retries are
              // already spent — so this path is the escalation: rewind (if
              // enabled), then the reaction.
              // Shed exactly one more (newest, in-sequence) turn and keep the
              // single episode marker current. `budgetLeft` bounds the loop.
              const doRewind = (
                budgetLeft: boolean,
                onStep: (count: number) => void,
                onGiveUp: () => void,
              ): void => {
                if (!budgetLeft) { onGiveUp(); return; }
                const rec = this.shedNewestTurn(agent);
                if (!rec) { onGiveUp(); return; }
                const count = this.updateRewindMarker(agent, category);
                onStep(count);
                if (forced) forced.removed.push(rec);
                this.pendingRequests.push({
                  agentName: agent.name,
                  reason: forced ? 'unstick-retry' : 'refusal-rewind-retry',
                  source: 'framework',
                  timestamp: Date.now(),
                });
                handledByRewind = true;
              };

              if (forced) {
                doRewind(
                  forced.remaining > 0,
                  (count) => {
                    forced.remaining -= 1;
                    console.error(
                      `[unstick] agent=${agent.name} shed ${count} turn(s) ` +
                        `(remaining ${forced.remaining})`,
                    );
                  },
                  () => this.finishUnstick(agent.name, false, category),
                );
              } else if (rh?.autoRewind) {
                const cap = Math.max(1, rh.maxRewinds ?? 3);
                const used = this.refusalRewinds.get(agent.name) ?? 0;
                doRewind(
                  used < cap,
                  (count) => {
                    this.refusalRewinds.set(agent.name, used + 1);
                    console.error(
                      `[refusal-rewind] agent=${agent.name} shed ${count} turn(s) so far ` +
                        `(cap ${cap})`,
                    );
                  },
                  () => {
                    console.error(
                      `[refusal-rewind] agent=${agent.name} gave up: ` +
                        `${used >= cap ? `cap ${cap} reached` : 'nothing left to shed'}`,
                    );
                    this.refusalRewinds.set(agent.name, 0);
                    this.rewindEpisode.delete(agent.name);
                  },
                );
              }

              // The reaction is the LAST resort: retries spent, rewind not
              // applicable. That makes it an honest signal to humans that the
              // border is close, rather than noise on every near-threshold
              // flip. (It must not re-enter any agent's context — the emoji
              // is suppressed at the surface via
              // DISCORD_SUPPRESS_REACTION_EMOJIS; without that, marking a
              // refusal feeds the next one.)
              if (!handledByRewind) {
                void this.reactToRefusal(agent.name, category);
              }
            } else {
              // A turn that completed WITHOUT a refusal ends the rewind episode:
              // the model responded. Leave the consolidated marker in place as
              // the durable record; just clear the per-episode counters.
              if (this.forcedRewind.has(agent.name)) {
                this.finishUnstick(agent.name, true);
              }
              if (this.refusalRewinds.get(agent.name)) {
                this.refusalRewinds.set(agent.name, 0);
              }
              this.rewindEpisode.delete(agent.name);
              this.refusalStreak.delete(agent.name);
            }

            // Dispatch speech (and thoughts if any)
            if (speechContent.length > 0 || thoughts.length > 0) {
              const speechContext: SpeechContext = {
                turnComplete: true,
                trigger: trigger ?? {
                  reason: 'unknown',
                  source: 'unknown',
                  timestamp: Date.now(),
                },
                thoughts: thoughts.length > 0 ? thoughts : undefined,
              };
              await this.moduleRegistry.dispatchSpeech(
                agent.name,
                speechContent,
                speechContext
              );
            }

            // Host-owned output routing (see LOCUS-ROUTING-DESIGN). On a
            // text-only turn (no tool calls => speechContent populated),
            // publish the agent's speech to the conversational locus — the
            // most recent incoming channel, tracked cross-surface in the
            // ChannelRegistry. This replaces discord-mcpl's per-surface sticky
            // auto-post. Tool-call turns produce `thoughts`, not `speech`, so
            // they are never routed here — which is precisely how the `think`
            // tool (and any explicit send tool) yields a silent turn.
            if (speechContent.length > 0 && this.channelRegistry) {
              const speechText = speechContent
                .map((b) => (b as ContentBlock & { type: 'text' }).text)
                .join('\n')
                .trim();
              if (speechText) {
                if (agent.proseRouting === 'disabled') {
                  console.error(`[routing] ${agent.name}: text-only prose NOT routed (proseRouting=disabled)`);
                  this.recordProseSuppression(agent.name, 1);
                } else if (agent.proseRouting === 'hybrid') {
                  const locus = resolveTurnLocus();
                  console.error(`[prose] ${agent.name}: text-only turn -> hybrid prose gateway`);
                  try {
                    await this.deliverHybridProse(agent, speechText, locus, true);
                  } catch (err) {
                    console.error('text-only hybrid prose delivery failed:', err);
                  }
                } else if (agent.proseRouting === 'explicit') {
                  console.error(`[prose] ${agent.name}: text-only turn -> prose gateway`);
                  try {
                    await this.deliverProse(agent, speechText);
                  } catch (err) {
                    console.error('text-only prose delivery failed:', err);
                  }
                } else {
                  // Route to the TURN-FROZEN locus, like every other speech
                  // path. This dispatch runs AFTER the agent is idle, so a live
                  // resolution here can read the NEXT turn's trigger state (or
                  // a post-restart cleared one) and land the reply in a stale
                  // channel — the 2026-07-22 Sol DM-to-guild misroute. The
                  // frozen pin is immune to both races.
                  const locus = resolveTurnLocus();
                  console.error(
                    `[routing] ${agent.name}: text-only turn -> routing speech -> ${locus ?? '(none)'}`,
                  );
                  try {
                    const outcome = await this.channelRegistry.routeSpeech(agent.name, speechText, locus);
                    this.recordProseDelivery(agent.name, outcome);
                  } catch (err) {
                    console.error('speech routing failed:', err);
                  }
                }
              }
            } else if (this.channelRegistry && hadToolCalls && allText.length > 0) {
              // Tool-call turn that also produced prose. When live routing was
              // active (native roundContent), each mid-turn round's prose was
              // already delivered when that round yielded — only the TRAILING
              // prose (blocks after the last tool round) remains here. On the
              // fallback path (XML tool mode / older membrane: no roundContent,
              // so nothing was live-routed) the historical behavior applies:
              // route the whole turn's parsed segments, once, now. The global
              // speech/thoughts split is left untouched (module/TUI rendering
              // unaffected) — this only governs what reaches the channel.
              //
              // Native round routing uses the live sticky flag, which a fresh
              // injected message can reset. The legacy/fallback path has no
              // reliable round boundaries, so retain its historical turn-wide
              // scan to avoid double-posting.
              const toolNames = response.content
                .filter((b) => b.type === 'tool_use')
                .map((b) => (b as unknown as { name?: string }).name)
                .filter((n): n is string => typeof n === 'string');
              const silenced = liveProseRouting
                ? turnSilenced
                : turnSilenced || toolNames.some((n) =>
                  SILENCING_TOOLS.has(bareToolName(n)) ||
                  (agent.proseRouting === 'hybrid' && HYBRID_PUBLICATION_TOOLS.has(bareToolName(n)))
                );

              const segments = splitProseSegments(liveProseRouting ? terminalContent : response.content);

              // Preserve in-channel ordering: everything enqueued live must
              // land before the trailing prose. Awaited even when silenced —
              // the chain may still be flushing earlier rounds' posts.
              await turnSpeechChain;

              if (agent.proseRouting === 'disabled') {
                if (segments.length > 0) {
                  console.error(
                    `[routing] ${agent.name}: tool-call trailing prose NOT routed (proseRouting=disabled)`,
                  );
                  this.recordProseSuppression(agent.name, segments.length);
                }
              } else if (agent.proseRouting === 'hybrid') {
                if (silenced && segments.length > 0) {
                  this.recordProseSuppression(agent.name, segments.length);
                } else if (segments.length > 0) {
                  const locus = resolveTurnLocus();
                  for (const seg of segments) {
                    try {
                      await this.deliverHybridProse(agent, seg, locus, true);
                    } catch (err) {
                      console.error('trailing hybrid prose delivery failed:', err);
                    }
                  }
                }
              } else if (agent.proseRouting === 'explicit') {
                if (segments.length > 0) {
                  console.error(
                    `[prose] ${agent.name}: tool-call turn [${toolNames.join(', ')}] -> ${segments.length} trailing segment(s) via prose gateway`,
                  );
                  for (const seg of segments) {
                    try {
                      await this.deliverProse(agent, seg);
                    } catch (err) {
                      console.error('trailing prose delivery failed:', err);
                    }
                  }
                }
              } else if (silenced || segments.length === 0) {
                console.error(
                  `[routing] ${agent.name}: tool-call turn [${toolNames.join(', ') || 'none'}] -> trailing prose NOT routed ` +
                  `(${silenced ? 'silencing tool / explicit send' : 'no trailing prose'})`,
                );
                if (silenced && segments.length > 0) {
                  this.recordProseSuppression(agent.name, segments.length);
                }
              } else {
                // Reuse the locus pinned at the turn's first live-routed
                // segment (or resolve it now for a turn whose only prose is
                // trailing). This dispatch runs AFTER the agent is idle (see
                // PR #32 note below), so a queued inbound from another channel
                // could otherwise overwrite the per-agent triggering channel
                // between segments — and a turn that narrated live into one
                // channel must not land its postscript in another.
                const locus = resolveTurnLocus();
                console.error(
                  `[routing] ${agent.name}: tool-call turn [${toolNames.join(', ')}] -> routing ${segments.length} ${liveProseRouting ? 'trailing ' : ''}prose segment(s) -> ${locus ?? '(default)'}`,
                );
                // Deliver sequentially (await each) so the segments land in order.
                for (const seg of segments) {
                  try {
                    const outcome = await this.channelRegistry.routeSpeech(agent.name, seg, locus);
                    this.recordProseDelivery(agent.name, outcome);
                  } catch (err) {
                    console.error('speech routing failed:', err);
                  }
                }
              }
            }
            // NOTE: agent.reset() + onInferenceEnded() already ran above,
            // BEFORE dispatchSpeech. Locus routing is speech dispatch and
            // doesn't depend on the status field, so it correctly runs after.

            // Logical turn end (normal completion): drop the `[delivered]`
            // receipt. All deliveries are settled — the live chain was
            // awaited before trailing dispatch, and trailing/text-only
            // segments were awaited in-loop. Locus mode only; explicit-mode
            // envelopes acknowledge themselves through the prose gateway.
            if (agent.proseRouting !== 'explicit') {
              this.appendProseDeliveryReceipt(agent);
            }

            // Explicit-prose `!` continuation: a prose segment this turn asked
            // to keep going (`>>#x !` / `>>private !`) — start another turn
            // now instead of pausing until the next external event. This gives
            // prose the same continuation ability tool rounds have (wanted for
            // robotics-style loops where an end-of-turn pause is harmful).
            if (this.proseContinuations.delete(agent.name)) {
              console.error(`[prose] ${agent.name}: '!' continuation — requesting immediate next turn`);
              this.pendingRequests.push({
                agentName: agent.name,
                reason: 'prose-continuation',
                source: 'framework',
                timestamp: Date.now(),
              });
            }

            break;
          }

          case 'error': {
            const err = event.error;
            const durationMs = Date.now() - startTime;
            this.emitTrace({
              type: 'inference:failed',
              agentName: agent.name,
              error: err.message,
              stack: err.stack,
            });

            this.logInference({
              timestamp: startTime,
              agentName: agent.name,
              requestId,
              success: false,
              error: err.message,
              request: compiledRequest ?? { note: 'streaming request failed' },
              durationMs,
            });

            // Only reset + retry if this is still the active stream
            if (agent.streamId !== myStreamId) break;

            this.abortAgentScript(agent.name, 'stream error');
            agent.reset();

            if (ownsProviderGate && this.holdProviderAcceleration(agent, err, trigger)) {
              lifecyclePhase = 'failed';
              this.eventGate?.onInferenceEnded(agent.name);
              break;
            }

            const action = this.errorPolicy.onInferenceError(err, agent.name, attempt);
            if (action.retry) {
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              await this.startAgentStream(agent, trigger, attempt + 1);
            } else {
              this.settleAgent(agent.name, {
                stopReason: 'exhausted',
                speech: '',
                error: err.message,
              });
              this.emitTrace({
                type: 'inference:exhausted',
                agentName: agent.name,
                error: err.message,
                // Drives the poison-history breaker. `retryable` is kept for
                // observability, but the breakers gate on `errorType` — only an
                // `invalid_request` (a 400-class rejection of the history
                // itself) means retrying the same context can never succeed.
                ...this.classifyInferenceError(err),
              });
              this.eventGate?.onInferenceEnded(agent.name);
              if (action.emit) {
                this.pushEvent(action.emit);
              }
            }
            break;
          }

          case 'aborted': {
            // Framework-initiated, non-terminal cancels (endTurn tool result,
            // context-budget restart) also surface here as `aborted` — but
            // the turn either already settled (endTurn) or a replacement
            // stream is queued (budget restart). Neither is a failure: no
            // reset, no settle, no spurious inference:exhausted (which would
            // reject an ephemeral's promise mid-run and bump the failure
            // streak). Gate release + stream teardown happen in `finally`.
            {
              const cancelKey = `${agent.name}:${myStreamId}`;
              const cancelKind = this.frameworkCancelledStreams.get(cancelKey);
              if (cancelKind !== undefined) {
                this.frameworkCancelledStreams.delete(cancelKey);
                lifecyclePhase = 'aborted'; // §10.5 — terminal emitted in finally
                this.eventGate?.onInferenceEnded(agent.name);
                // endTurn IS a logical turn end — earlier rounds may have
                // live-routed prose (narrate → skip_reply is a real shape),
                // so settle the delivery chain and drop the receipt. A
                // budget restart continues the same logical turn: the
                // deliveries map persists (cleared only at fresh turn
                // start) and the continuation stream's end writes ONE
                // receipt for the whole turn.
                if (cancelKind === 'turn_ended' && agent.proseRouting !== 'explicit') {
                  await turnSpeechChain;
                  this.appendProseDeliveryReceipt(agent);
                }
                return;
              }
            }
            const reason = event.reason ?? 'unknown';
            // Only reset if this is still the active stream (a budget restart
            // may have already started a new stream, bumping streamId)
            if (agent.streamId === myStreamId) {
              const durationMs = Date.now() - startTime;
              this.abortAgentScript(agent.name, `stream aborted (${reason})`);
              agent.reset();
              this.settleAgent(agent.name, {
                stopReason: 'exhausted',
                speech: '',
                error: `Stream aborted: ${reason}`,
              });
              this.emitTrace({
                type: 'inference:exhausted',
                agentName: agent.name,
                error: `Stream aborted: ${reason}`,
              });
              // Postmortem 2026-05-28 P2 #7: persist the abort to the
              // inference log so future investigations can attribute the
              // terminal cause without relying on live in-memory reducer
              // state. Without this, abort-terminated inferences are
              // invisible to forensic queries (only request-side telemetry
              // via llm-calls.jsonl shows them, and only by absence).
              this.logInference({
                timestamp: startTime,
                agentName: agent.name,
                requestId,
                success: false,
                error: `Stream aborted: ${reason}`,
                request: compiledRequest ?? { note: 'streaming request aborted' },
                durationMs,
              });
              this.eventGate?.onInferenceEnded(agent.name);
            }
            break;
          }

          case 'usage': {
            agent.lastStreamInputTokens = event.usage.inputTokens;
            agent.lastStreamRealInputTokens =
              (event.usage.inputTokens ?? 0) +
              (event.usage.cacheCreationTokens ?? 0) +
              (event.usage.cacheReadTokens ?? 0);
            agent.lastStreamOutputTokens = event.usage.outputTokens ?? 0;

            // Closed-loop estimator calibration (2026-07-12). Sample the REAL
            // prefix size of THIS API call (fresh + cache write + cache read)
            // and hand it to the context strategy, which accepts exactly one
            // sample per compile (its arm-once gate) and rejects out-of-band
            // ratios. It must be sampled HERE, per call: `response.details.
            // usage` at turn completion is CUMULATIVE across the tool-use
            // loop (5 calls x ~160k reported as 884k), which is not a
            // window-shaped number and drove the multiplier to 2.37 before
            // the guards caught it.
            try {
              const realTotal =
                (event.usage.inputTokens ?? 0) +
                (event.usage.cacheCreationTokens ?? 0) +
                (event.usage.cacheReadTokens ?? 0);
              const strat = (agent as unknown as {
                getContextManager?: () => { getStrategy?: () => unknown };
              }).getContextManager?.()?.getStrategy?.() as
                | { reportRealInputTokens?: (n: number) => void }
                | undefined;
              strat?.reportRealInputTokens?.(realTotal);
            } catch { /* calibration is best-effort */ }

            this.emitTrace({
              type: 'inference:usage',
              agentName: agent.name,
              tokenUsage: {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
                cacheCreation: event.usage.cacheCreationTokens,
                cacheRead: event.usage.cacheReadTokens,
              },
            });
            break;
          }
        }
      }
    } catch (error) {
      // Stream itself threw. Organization acceleration is deferred from a
      // fresh compile; every other throw keeps the ordinary exhausted path.
      const err = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startTime;
      if (ownsProviderGate && this.holdProviderAcceleration(agent, err, trigger)) {
        this.emitTrace({ type: 'inference:failed', agentName: agent.name, error: err.message, stack: err.stack });
        this.logInference({ timestamp: startTime, agentName: agent.name, requestId, success: false,
          error: `Provider acceleration cooldown: ${err.message}`,
          request: compiledRequest ?? { note: 'streaming request rate-limited' }, durationMs });
        this.abortAgentScript(agent.name, 'provider acceleration cooldown');
        lifecyclePhase = 'failed'; agent.reset(); this.eventGate?.onInferenceEnded(agent.name);
        return;
      }
      this.emitTrace({
        type: 'inference:failed',
        agentName: agent.name,
        error: err.message,
        stack: err.stack,
      });
      this.settleAgent(agent.name, {
        stopReason: 'exhausted',
        speech: '',
        error: err.message,
      });
      this.emitTrace({
        type: 'inference:exhausted',
        agentName: agent.name,
        error: err.message,
        ...this.classifyInferenceError(err),
      });
      // Postmortem 2026-05-28 P2 #7: catch-path failures (stream itself
      // threw) were previously only visible via in-memory trace listeners.
      // Persist to inference log for forensic attribution.
      this.logInference({
        timestamp: startTime,
        agentName: agent.name,
        requestId,
        success: false,
        error: `Stream threw: ${err.message}`,
        request: compiledRequest ?? { note: 'streaming request threw' },
        durationMs,
      });
      this.abortAgentScript(agent.name, 'stream threw');
      lifecyclePhase = 'failed'; // §10.5 — terminal emitted in finally
      agent.reset();
      this.eventGate?.onInferenceEnded(agent.name);
    } finally {
      // §10.5: exactly one terminal per `started`, on every exit path the
      // host controls. Which one was decided by the path taken (default
      // completed; catch → failed; framework-cancel → aborted). A host
      // crash emits nothing — that is the documented best-effort limit, and
      // why consumers keep their safety timeout.
      this.hookOrchestrator?.emitLifecycle({
        inferenceId: outgoingInferenceId,
        conversationId: agent.name,
        turnIndex: 0,
        phase: lifecyclePhase,
      });
      // Clear the gate's inference flag on EVERY exit path (paired with the
      // onInferenceStarted in startAgentStream). The branch-level calls above
      // are kept but are best-effort; if any exit path bypassed them the agent
      // stayed stuck in the gate's `inferring` set, which permanently BUFFERS
      // all incoming events → the agent silently stops waking on messages
      // (typing still stops, compression still runs — matching the observed
      // wedge). onInferenceEnded is idempotent, so a redundant call is safe.
      this.eventGate?.onInferenceEnded(agent.name);
      this.lastInferenceAt.set(agent.name, { ...this.lastInferenceAt.get(agent.name), endedAt: Date.now() });
      if (ownsProviderGate) this.releasePrimaryProviderGate(agent.name);

      // Stop the typing indicator on every exit path (complete, error,
      // exhausted, abort) so it never sticks after the turn ends.
      this.channelRegistry?.stopTyping();

      // Spec 14.3: flush any held line-start text, then close each streamed
      // channel with its final moderated content — the consumer's signal to
      // finalize (end the TTS utterance, settle the rendered message).
      if (proseStream) {
        emitOutgoing(proseStream.finish());
        for (const [channelId, text] of proseStream.byChannel()) {
          this.channelRegistry!.sendOutgoingComplete(channelId, agent.name, outgoingInferenceId, text);
        }
      }
      this.frameworkCancelledStreams.delete(`${agent.name}:${myStreamId}`);
      this.activeStreams.delete(agent.name);
      this.pendingAssistantBlocks.delete(agent.name);

      // A conversation fork whose TTL closure turn just finished is done for
      // good — dispose it so the agent map doesn't grow monotonically.
      if (this.closingConversationAgents.has(agent.name)) {
        this.disposeConversationAgent(agent.name);
      }

      // The turn is torn down — release the turn-alive marker BEFORE the
      // deferred flush below, so the flush appends at the settled tail.
      // Token-matched: if a successor turn already owns the agent (endTurn
      // reset the state machine before this finally ran — the 2026-07-31
      // interleave), leave its marker alone; the guarded addMessage below
      // then re-defers, and the successor's own turn-start flush / boundary
      // injection / teardown delivers the messages at a correct position.
      if (myTurnToken !== undefined && this.activeTurnTokens.get(agent.name) === myTurnToken) {
        this.activeTurnTokens.delete(agent.name);
      }

      // Flush any deferred messages (e.g. if stream failed while tools were pending)
      if (this.deferredMessages.length > 0 && this.pendingAssistantBlocks.size === 0) {
        const deferred = this.deferredMessages.splice(0);
        for (const msg of deferred) {
          this.addMessage(msg.participant, msg.content, msg.metadata);
        }
      }
    }
  }

  /**
   * Execute a tool call and return the result.
   * Routes to the appropriate handler (module registry or MCPL).
   * Used by SubagentModule to dispatch tool calls for ephemeral agents.
   *
   * This public entry always carries AGENT origin. Ephemeral/promise-based
   * callers are models, and provenance must identify which internal path a
   * call entered through — a public method shared with model callers can
   * never confer module trust, whatever the input claims. Module origin
   * exists only through the private closure handed to ModuleRegistry
   * (ctx.callTool → executeToolCallFrom with {kind:'module'}). Callers that
   * don't identify themselves fail safe to agent semantics too.
   */
  async executeToolCall(call: ToolCall): Promise<ToolResult> {
    return this.executeToolCallFrom(call, {
      kind: 'agent',
      agentName: call.callerAgentName ?? '__ephemeral__',
    });
  }

  /**
   * Admin puppet: execute ONE tool call AS an agent and persist the
   * tool_use + tool_result pair in that agent's window exactly as a
   * model-initiated call is stored.
   *
   * Born from the princess exemplar surgery (2026-08-23). Her folded
   * narrative said "I have no tools"; every past tool_use/tool_result pair
   * had folded out of her context, so the act of calling had no in-context
   * exemplar and she could not emit her first call despite 30 eidoverse
   * tools riding every request. Placing one first-person pair restored the
   * capacity. That repair required stop → store surgery → restart; this
   * method is the live path — and the general lever for demonstrating an
   * affordance to a model that cannot find it (older models especially).
   *
   * Semantics:
   * - Refused unless the agent is idle: puppeting mid-turn would corrupt
   *   the turn state machine and the live stream's wire ordering.
   * - Refused for tools outside the agent's own surface (canUseTool): the
   *   stored pair must be an act the agent could genuinely have taken.
   * - The call executes FOR REAL through the shared dispatch (MCPL,
   *   channel tools, utils, modules) with the agent's provenance — a
   *   puppeted walk_to actually moves the avatar.
   * - Storage byte-follows the ordinary path: a bare tool_use assistant
   *   message (no fabricated thinking or text — a stored assistant turn
   *   with unverifiable thinking is the labclaude 400 class) plus a
   *   tool_result under the same bounded spill policy (issue #89).
   * - Does NOT request inference; the agent sees the pair on its next
   *   wake. Speak to the agent afterward if a wake is wanted.
   * - Provenance is loud in traces (puppet:tool-call) and the host log,
   *   deliberately NOT in the stored messages — metadata there would break
   *   byte-parity with real turns. Whether to disclose to the resident is
   *   the operator's call; the princess precedent was disclosed first.
   */
  async puppetToolCall(
    agentName: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ toolUseId: string; result: ToolResult }> {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);
    if (agent.state.status !== 'idle') {
      throw new Error(
        `puppet refused: agent ${agentName} is ${agent.state.status} (requires idle — ` +
        `injecting a turn under an active stream corrupts wire ordering)`,
      );
    }
    const onSurface = this.getToolsForAgent(agentName)
      .some((t) => t.name === toolName && agent.canUseTool(t.name));
    if (!onSurface) {
      throw new Error(
        `puppet refused: tool ${toolName} is not on ${agentName}'s surface — ` +
        `the stored pair must be an act the agent could genuinely have taken`,
      );
    }

    // Anthropic-shaped id so the stored pair is indistinguishable from a
    // provider-issued call.
    const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 22; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    const toolUseId = `toolu_01${suffix}`;

    const started = Date.now();
    const result = await this.executeToolCall({
      id: toolUseId,
      name: toolName,
      input,
      callerAgentName: agentName,
    });
    const durationMs = Date.now() - started;

    // Store the pair through the same shapes the ordinary path uses. Build
    // the result blocks BEFORE storing the tool_use: the spill path awaits,
    // and a message arriving during that await must land before the pair,
    // never between tool_use and its tool_result. The two addMessage calls
    // below are synchronous and adjacent — nothing can interleave.
    const { blocks } = await this.buildStoredToolResultContent(
      [{ id: toolUseId, name: toolName, input, result, durationMs }],
      this.resolveToolResultInlineCap(agent).cap,
    );
    const cm = agent.getContextManager();
    cm.addMessage(agentName, [
      { type: 'tool_use', id: toolUseId, name: toolName, input } as ContentBlock,
    ]);
    cm.addMessage('user', blocks);

    this.emitTrace({
      type: 'puppet:tool-call',
      agentName,
      toolName,
      toolUseId,
      isError: !!result.isError,
      durationMs,
    });
    console.log(
      `[puppet] ${agentName}: ${toolName} → ${result.isError ? 'ERROR' : 'ok'} ` +
      `in ${durationMs}ms (${toolUseId})`,
    );
    return { toolUseId, result };
  }

  private async executeToolCallFrom(call: ToolCall, origin: ChannelToolOrigin): Promise<ToolResult> {
    // Client-side programmatic tool calling for promise-based callers
    // (SubagentModule ephemerals). Keyed by callerAgentName so each ephemeral
    // gets its own interpreter state.
    if (call.name === CODE_EXECUTION_TOOL_NAME && this.codeExecutionConfig) {
      return this.runCodeExecution(call.callerAgentName ?? '__ephemeral__', call);
    }

    // MCPL tools are dispatched via the MCPL subsystem
    if (this.mcplServerRegistry) {
      // Check if this is an MCPL-prefixed tool
      const prefix = call.name.split('--').slice(0, -1).join('--');
      const serverConfigs = this.mcplServerConfigs;
      for (const [, config] of serverConfigs) {
        const toolPrefix = config.toolPrefix ?? `mcpl--${config.id}`;
        if (call.name.startsWith(toolPrefix + '--')) {
          return this.executeMcplToolCall(call, config);
        }
      }
    }

    // Synthesized channel tools. This route was missing: when
    // subscription-GC moved off the retired MCPL unsubscribe tool onto the
    // generic channel_close (discord-mcpl b095a9f), module-originated
    // closes started failing downstream as "Invalid tool name format" —
    // the janitor had been silently broken since. `origin` is trusted
    // dispatch context established at the call boundary above, not
    // inferred from which method was used: only the ModuleRegistry closure
    // carries module provenance (see handleToolClose). The agent-only
    // synthesized verbs (think, skip_reply) are deliberately not routed
    // here.
    if (call.name.startsWith('channel_') && this.channelRegistry) {
      return this.channelRegistry.handleChannelToolCall(call.name, call.input, origin);
    }

    // The utils meta-tool — programmatic callers (code_execution scripts,
    // ephemerals, ModuleContext.callTool) reach utilities the same way the
    // model does.
    if (call.name === 'utils') {
      return this.handleUtilsToolCall(call.callerAgentName ?? '__ephemeral__', call);
    }

    // Module tools
    return this.moduleRegistry.handleToolCall(call);
  }

  private async executeMcplToolCall(call: ToolCall, config: McplServerConfig): Promise<ToolResult> {
    if (!this.mcplServerRegistry) {
      return { success: false, error: 'MCPL not initialized', isError: true };
    }
    const server = this.mcplServerRegistry.getServer(config.id);
    if (!server) {
      return { success: false, error: `MCPL server ${config.id} not found`, isError: true };
    }
    const prefix = config.toolPrefix ?? `mcpl--${config.id}`;
    const toolName = call.name.slice(prefix.length + 2); // Strip prefix + '--'
    if (!isToolAllowed(toolName, config)) {
      return {
        success: false,
        error: `Tool '${call.name}' is not permitted by this server's tool policy.`,
        isError: true,
      };
    }
    try {
      const result = await server.sendToolsCall(toolName, call.input as Record<string, unknown>);
      return {
        success: true,
        data: result.content,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Client-side programmatic tool calling (code_execution)
  // ---------------------------------------------------------------------------

  /** Event-pushing wrapper for the model-driven dispatch path. */
  private dispatchCodeExecutionToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({
      type: 'tool:started',
      module: 'code_execution',
      tool: call.name,
      callId: call.id,
      input: call.input,
    });
    const startTime = Date.now();
    this.runCodeExecution(agentName, call)
      .catch((error): ToolResult => {
        // runCodeExecution is designed not to reject; this is the last-resort
        // guard so a bug here can never strand the agent in waiting_for_tools.
        const err = error instanceof Error ? error : new Error(String(error));
        return { success: false, error: `code_execution failed: ${err.message}`, isError: true };
      })
      .then((result) => {
        if (result.isError) {
          this.emitTrace({
            type: 'tool:failed',
            module: 'code_execution',
            tool: call.name,
            callId: call.id,
            error: result.error ?? 'unknown error',
          });
        } else {
          this.emitTrace({
            type: 'tool:completed',
            module: 'code_execution',
            tool: call.name,
            callId: call.id,
            durationMs: Date.now() - startTime,
          });
        }
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'code_execution',
          result,
        });
      });
  }

  /**
   * Run one code_execution script for an agent. Never rejects.
   *
   * The script runs in the agent's persistent python interpreter with every
   * tool on the agent's CURRENT surface injected (minus code_execution
   * itself). Inner tool calls are dispatched through dispatchToolCall — the
   * exact model path, including MCPL state/checkpoint handling, channel
   * routing, and traces — and resolved via scriptToolWaiters, so their
   * results reach the running script and never the model context.
   */
  private async runCodeExecution(agentName: string, call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as {
      code?: unknown;
      background?: unknown;
      action?: unknown;
      script_id?: unknown;
    };

    // Management surface: the agent's own daemon fleet is inspectable and
    // killable through the same tool that spawns it.
    if (input.action === 'list') {
      const scripts = [...this.backgroundScripts.values()]
        .filter((s) => s.agentName === agentName)
        .map((s) => ({
          script_id: s.id,
          status: s.status,
          started_at: new Date(s.startedAt).toISOString(),
          wakes: s.wakes,
          last_wake_at: s.lastWakeAt ? new Date(s.lastWakeAt).toISOString() : null,
          log: s.logPath,
        }));
      return { success: true, data: { background_scripts: scripts } };
    }
    if (input.action === 'cancel') {
      if (typeof input.script_id !== 'string') {
        return { success: false, error: 'cancel requires `script_id`', isError: true };
      }
      const record = this.backgroundScripts.get(input.script_id);
      if (!record || record.agentName !== agentName) {
        return { success: false, error: `no background script '${input.script_id}'`, isError: true };
      }
      if (record.status === 'running') {
        record.cancelled = true;
        record.status = 'cancelled';
        record.runner.abort('cancelled by agent');
        record.runner.dispose();
      }
      return {
        success: true,
        data: { script_id: record.id, status: record.status, log: record.logPath },
      };
    }
    if (input.action !== undefined && input.action !== 'run') {
      return { success: false, error: `unknown action ${JSON.stringify(input.action)}`, isError: true };
    }

    if (typeof input.code !== 'string' || input.code.trim() === '') {
      return {
        success: false,
        error: 'code_execution requires a non-empty `code` string',
        isError: true,
      };
    }

    const agent = this.agents.get(agentName);
    const surface = agent
      ? this.getToolsForAgent(agentName).filter((t) => agent.canUseTool(t.name))
      : this.getAllTools(); // ephemeral agents: full surface, matching executeToolCall
    const injected = buildInjectedTools(
      surface.map((t) => t.name).filter((name) => name !== CODE_EXECUTION_TOOL_NAME),
    );

    if (input.background === true) {
      return this.startBackgroundScript(agentName, input.code, injected);
    }

    const runner = this.getOrCreateScriptRunner(agentName);
    this.scriptDeferredEndTurn.delete(agentName);
    const exec = await runner.exec(input.code, injected);
    const endTurn = this.scriptDeferredEndTurn.delete(agentName);

    return {
      success: true,
      data: { stdout: exec.stdout, stderr: exec.stderr, return_code: exec.returnCode },
      isError: false,
      ...(endTurn ? { endTurn: true } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Background (daemon) scripts — model-authored watchers that outlive the turn
  // ---------------------------------------------------------------------------

  /**
   * Start a background script: dedicated interpreter, output journaled to a
   * workspace file, wake_agent() available in-script. The tool result
   * returns immediately; the script runs until it ends, hits the lifetime
   * ceiling, or is cancelled. Scripts DIE WITH THE HOST PROCESS — that
   * limitation is stated in the tool description so agents can calibrate
   * how much to rely on an armed wake.
   */
  private startBackgroundScript(
    agentName: string,
    code: string,
    injected: import('./code-execution/py-runner.js').InjectedTool[],
  ): ToolResult {
    // v1: primary-agent-only. A conversation fork's or ephemeral's daemon
    // would outlive its owner and its wake would land in the primary
    // conversation anyway — refuse loudly instead of surprising anyone.
    if (this.primaryAgentName && agentName !== this.primaryAgentName) {
      return {
        success: false,
        error: 'background scripts are available to the primary agent only',
        isError: true,
      };
    }
    const cfg = this.codeExecutionConfig;
    const maxScripts = cfg?.maxBackgroundScripts ?? 3;
    const runningCount = [...this.backgroundScripts.values()]
      .filter((s) => s.agentName === agentName && s.status === 'running').length;
    if (runningCount >= maxScripts) {
      return {
        success: false,
        error: `background script limit reached (${maxScripts} running). ` +
          'Use code_execution {"action": "list"} to inspect and {"action": "cancel", "script_id": ...} to free a slot.',
        isError: true,
      };
    }

    const scriptId = `bg-${++this.backgroundScriptCounter}`;
    const lifetimeMs = cfg?.backgroundMaxLifetimeMs ?? 86_400_000;

    // Journal: a file under the agent's first read-write workspace mount so
    // their existing read/grep/shell tools work on it. Python appends
    // directly to the materialized path; watch-mode mounts sync it back to
    // the chronicle tree on their usual cadence.
    let logPath: string | null = null;
    let logAbsPath: string | null = null;
    const workspace = this.getWorkspaceModule();
    if (workspace) {
      const mountName = this.firstWritableMountName(workspace);
      if (mountName) {
        logPath = `${mountName}/background-scripts/${scriptId}.log`;
        logAbsPath = workspace.resolveAbsolutePath(logPath);
      }
    }

    const runner = new PyRunner({
      pythonPath: cfg?.pythonPath,
      toolCallTimeoutMs: cfg?.toolCallTimeoutMs,
      scriptTimeoutMs: cfg?.scriptTimeoutMs,
      idleReclaimMs: 0, // dedicated runner; lifetime is the exec deadline
      label: `${agentName}:${scriptId}`,
      onToolCall: (toolName, args) => this.handleScriptToolCall(agentName, toolName, args),
    });

    const record: BackgroundScriptRecord = {
      id: scriptId,
      agentName,
      runner,
      code,
      startedAt: Date.now(),
      wakes: 0,
      lastWakeAt: null,
      logPath,
      status: 'running',
      cancelled: false,
    };
    this.backgroundScripts.set(scriptId, record);
    this.emitTrace({
      type: 'tool:started', module: 'code_execution', tool: `background:${scriptId}`,
      callId: scriptId, input: { lines: code.split('\n').length },
    });

    void runner
      .exec(code, injected, {
        logPath: logAbsPath,
        lifetimeMs,
        onWake: (line, payload) => this.handleScriptWake(record, line, payload),
      })
      .then((exec) => this.settleBackgroundScript(record, exec))
      .catch((err) => {
        // exec never rejects by contract; this is the belt-and-suspenders.
        console.error(`[pytc:${agentName}:${scriptId}] background exec rejected: ${String(err)}`);
        this.settleBackgroundScript(record, {
          stdout: '', stderr: String(err), returnCode: 1, aborted: true,
        });
      });

    return {
      success: true,
      data: {
        status: 'background script started',
        script_id: scriptId,
        log: logPath ?? 'no writable workspace mount — output is not retrievable; only wake_agent() reaches you',
        lifetime_hours: Math.round(lifetimeMs / 3_600_000 * 10) / 10,
        note: 'The script dies if the host process restarts. Manage with code_execution {"action": "list"|"cancel"}.',
      },
    };
  }

  /** First read-write mount name, or null. */
  private firstWritableMountName(workspace: WorkspaceModule): string | null {
    const mounts = (workspace as unknown as {
      getMounts?: () => Array<{ name: string; mode: string }>;
    }).getMounts?.();
    if (mounts) {
      const rw = mounts.find((m) => m.mode !== 'read-only');
      return rw?.name ?? null;
    }
    return null;
  }

  /**
   * wake_agent() from a background script: enforce the per-script wake cap
   * and rate floor (delay, not drop — the script awaits the ack), then
   * inject the provenance envelope + payload and request inference.
   * Resolves null on delivery; an error string refuses the wake (raises
   * RuntimeError inside the script).
   */
  private async handleScriptWake(
    record: BackgroundScriptRecord,
    line: number,
    payload: unknown,
  ): Promise<string | null> {
    if (record.cancelled) return 'script was cancelled';
    const cfg = this.codeExecutionConfig;
    const maxWakes = cfg?.maxWakesPerScript ?? 100;
    if (record.wakes >= maxWakes) {
      return `wake limit reached (${maxWakes} per script)`;
    }
    const floorMs = cfg?.wakeMinIntervalMs ?? 60_000;
    if (record.lastWakeAt !== null) {
      const wait = record.lastWakeAt + floorMs - Date.now();
      if (wait > 0) {
        await new Promise((r) => {
          const t = setTimeout(r, wait);
          (t as { unref?: () => void }).unref?.();
        });
        if (record.cancelled) return 'script was cancelled';
      }
    }
    record.wakes += 1;
    record.lastWakeAt = Date.now();

    const elapsedMin = Math.round((Date.now() - record.startedAt) / 60_000);
    const payloadJson = payload === undefined || payload === null
      ? 'null'
      : JSON.stringify(payload, null, 1) ?? String(payload);
    const agent = this.agents.get(record.agentName);
    // Same resolved cap as tool results (override applies here too); an
    // unknown agent still gets the bounded house default, never unbounded.
    const maxChars = agent
      ? this.resolveToolResultInlineCap(agent).cap
      : DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS;
    const { text: payloadText } = await this.spillOrTruncate(
      payloadJson, maxChars, `${record.id}-wake${record.wakes}`,
    );

    const envelope =
      `[background script ${record.id}] Woke you: wake_agent() called at line ${line} of your script, ` +
      `${elapsedMin}m after you started it (wake ${record.wakes} of ${maxWakes}).\n` +
      `Arguments:\n${payloadText}\n` +
      (record.logPath ? `Script output so far: workspace file ${record.logPath}\n` : '') +
      `Script status: still running`;

    this.injectScriptWake(record, envelope);
    return null;
  }

  /** Background script ended (clean, crash, deadline, cancel/dispose). */
  private settleBackgroundScript(
    record: BackgroundScriptRecord,
    exec: import('./code-execution/py-runner.js').ExecResult,
  ): void {
    record.runner.dispose();
    if (record.status === 'running') {
      record.status = exec.returnCode === 0 ? 'finished' : 'died';
    }
    this.emitTrace({
      type: 'tool:completed', module: 'code_execution', tool: `background:${record.id}`,
      callId: record.id, durationMs: Date.now() - record.startedAt,
    });
    // Crash honesty: a resident sleeping on a promise must never have that
    // promise die silently. Deliberate cancels/disposes stay silent (the
    // agent or host chose them); clean exits stay silent (the null path).
    if (record.status === 'died' && !record.cancelled) {
      const tail = (exec.tail ?? exec.stderr ?? '').slice(-2000);
      const elapsedMin = Math.round((Date.now() - record.startedAt) / 60_000);
      const envelope =
        `[background script ${record.id}] Your background script DIED ${elapsedMin}m after start ` +
        `(it did not call wake_agent and is no longer watching).\n` +
        `Last output:\n${tail || '(none)'}\n` +
        (record.logPath ? `Full journal: workspace file ${record.logPath}` : '');
      this.injectScriptWake(record, envelope);
    }
    // Keep a short memory of settled scripts for {"action":"list"}, then drop.
    const settled = [...this.backgroundScripts.values()]
      .filter((s) => s.agentName === record.agentName && s.status !== 'running');
    for (const old of settled.slice(0, Math.max(0, settled.length - 5))) {
      this.backgroundScripts.delete(old.id);
    }
  }

  /**
   * Deliver a background-script event: provenance envelope into the agent's
   * context + an inference request. Deliberately does NOT consult the event
   * gate — the agent armed this wake themselves (wake-through-sleep
   * authority); it enters tagged so gate policies could be taught about it
   * later if that ever needs revisiting.
   */
  private injectScriptWake(record: BackgroundScriptRecord, envelope: string): void {
    try {
      const messageId = this.addMessage('user', [{ type: 'text', text: envelope }], {
        source: 'background-script',
        scriptId: record.id,
        tags: ['script:wake'],
      });
      this.pendingRequests.push({
        agentName: record.agentName,
        reason: 'script:wake',
        source: 'code_execution',
        timestamp: Date.now(),
      });
      this.emitTrace({
        type: 'message:added',
        messageId,
        source: `background-script:${record.id}`,
      });
    } catch (err) {
      console.error(
        `[pytc:${record.agentName}:${record.id}] wake injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Oversized content policy (antra, 2026-07-31; completed for issue #89):
   * never hit the agent in the face with a huge blob, never silently destroy
   * it either. Content over the inline cap is materialized to a workspace
   * file (readable with the agent's own tools — deterministic name, kept
   * until the workspace owner deletes it) and replaced by a truncated head +
   * a trailing file reference. Falls back to EXPLICIT plain truncation when
   * there is no writable workspace. Cap resolution lives in
   * resolveToolResultInlineCap; callers pass the resolved cap.
   */
  /**
   * One spill policy for every stored tool_result block: serialize (history
   * serializer — image blocks become placeholders), then spill/truncate at
   * the resolved cap. Errors follow the same policy as successes — a giant
   * error string is exactly as context-hostile as a giant success (issue
   * #89). Returns the stored blocks plus the per-call spill outcomes so the
   * live wire copy can reuse the identical strings.
   */
  private async buildStoredToolResultContent(
    toolResults: CompletedToolCall[],
    maxChars: number | undefined,
  ): Promise<{
    blocks: ContentBlock[];
    spilled: Map<string, { text: string; filePath: string | null }>;
  }> {
    const spilled = new Map<string, { text: string; filePath: string | null }>();
    const dateLabel = new Date().toISOString().slice(0, 10);
    for (const tc of toolResults) {
      const raw = tc.result.isError
        ? tc.result.error ?? 'Unknown error'
        : toolResultDataToHistoryString(tc.result.data, undefined);
      spilled.set(tc.id, await this.spillOrTruncate(raw, maxChars, `${dateLabel}-${tc.id}`));
    }
    const blocks: ContentBlock[] = toolResults.map(tc => ({
      type: 'tool_result' as const,
      toolUseId: tc.id,
      // Persisted so XML replay can reconstruct the legacy <tool_name>
      // element byte-identically to the live injection.
      toolName: tc.name,
      content: spilled.get(tc.id)!.text,
      isError: tc.result.isError,
    }));
    return { blocks, spilled };
  }

  private async spillOrTruncate(
    content: string,
    cap: number | undefined,
    label: string,
  ): Promise<{ text: string; filePath: string | null }> {
    if (!cap || content.length <= cap) return { text: content, filePath: null };

    const workspace = this.getWorkspaceModule();
    const mountName = workspace ? this.firstWritableMountName(workspace) : null;
    if (workspace && mountName) {
      const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const path = `${mountName}/tool-results/${safeLabel}.txt`;
      let failure: string;
      try {
        const result = await workspace.writeBinary(path, Buffer.from(content, 'utf8'), 'text/plain');
        if (result.success) {
          return {
            text: safeSlice(content, 0, cap)
              + `\n\n[truncated — showing ${cap} of ${content.length} chars; full content: workspace file ${path}. `
              + 'Read/grep it with your file tools, or raise the inline cap via '
              + 'agent_settings update tool_result_inline_max_chars.]',
            filePath: path,
          };
        }
        failure = result.error ?? 'write refused';
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      // A workspace was there and the write FAILED — say that, loudly and
      // distinctly. Telling the agent "no writable workspace" would teach
      // them their residence lacks a capability it actually has.
      failure = failure.slice(0, 200);
      this.emitTrace({
        type: 'tool:spill_failed',
        label: safeLabel,
        path,
        contentLength: content.length,
        error: failure,
      });
      console.error(
        `[spill] workspace write failed for ${path} (${content.length} chars): ${failure}`,
      );
      return {
        text: safeSlice(content, 0, cap)
          + `\n\n[truncated — showing ${cap} of ${content.length} chars; spill to workspace file ${path} FAILED`
          + ` (${failure}); content over the cap was not retained]`,
        filePath: null,
      };
    }
    return {
      text: safeSlice(content, 0, cap)
        + '\n\n[truncated — original was ' + content.length + ' chars; no writable workspace, full content not retained]',
      filePath: null,
    };
  }

  private getOrCreateScriptRunner(agentName: string): PyRunner {
    let runner = this.codeExecutionRunners.get(agentName);
    if (!runner) {
      const cfg = this.codeExecutionConfig;
      runner = new PyRunner({
        pythonPath: cfg?.pythonPath,
        toolCallTimeoutMs: cfg?.toolCallTimeoutMs,
        scriptTimeoutMs: cfg?.scriptTimeoutMs,
        idleReclaimMs: cfg?.idleReclaimMs,
        label: agentName,
        onToolCall: (toolName, args) => this.handleScriptToolCall(agentName, toolName, args),
      });
      this.codeExecutionRunners.set(agentName, runner);
    }
    return runner;
  }

  /**
   * Resolve one script-inner tool call to the string the script's tool
   * function returns. Never rejects — errors become "Error: ..." strings,
   * matching the managed PTC runtime ("Claude's code receives this error").
   *
   * Results are serialized with the HISTORY serializer (images become
   * placeholders): programmatic tool results are text-only by contract, and
   * a script variable holding megabytes of base64 helps nobody.
   */
  private async handleScriptToolCall(
    agentName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (toolName === CODE_EXECUTION_TOOL_NAME) {
      return 'Error: code_execution cannot be called from within a script';
    }
    const result = await this.dispatchScriptToolCall(agentName, toolName, args);
    if (result.endTurn) {
      // Deferred: applied to the final code_execution result (see
      // scriptDeferredEndTurn) — ending the turn mid-script would cancel the
      // stream while the script still runs and wedge the tool round.
      this.scriptDeferredEndTurn.add(agentName);
    }
    if (result.isError) {
      return `Error: ${result.error ?? 'tool call failed'}`;
    }
    if (result.data === undefined) return '';
    // Scripts get (nearly) full data — the script environment IS the spill:
    // filtering big results in code is the whole point. 5MB protocol safety
    // cap only; no context-cap truncation, no file spill.
    return toolResultDataToHistoryString(result.data, 5_000_000);
  }

  /**
   * Dispatch a script-inner tool call through the NORMAL dispatch path and
   * resolve with its result. The waiter intercept in handleProcessEvent
   * (keyed by the pytc- call ID) routes the tool-result event here instead
   * of into the agent's pending tool round.
   */
  private dispatchScriptToolCall(
    agentName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const callId = `pytc-${randomUUID()}`;
      // Host-side leak guard: the python runtime already raises TimeoutError
      // at toolCallTimeoutMs; this only reclaims the waiter if a dispatch path
      // loses the result entirely (so the map cannot grow unboundedly).
      const safetyMs = (this.codeExecutionConfig?.toolCallTimeoutMs ?? 270_000) + 30_000;
      const safety = setTimeout(() => {
        if (this.scriptToolWaiters.delete(callId)) {
          resolve({
            success: false,
            error: `tool '${toolName}' produced no result within ${Math.round(safetyMs / 1000)}s`,
            isError: true,
          });
        }
      }, safetyMs);
      safety.unref?.();

      this.scriptToolWaiters.set(callId, (result) => {
        clearTimeout(safety);
        resolve(result);
      });

      try {
        this.dispatchToolCall(agentName, { id: callId, name: toolName, input: args });
      } catch (error) {
        if (this.scriptToolWaiters.delete(callId)) {
          clearTimeout(safety);
          const err = error instanceof Error ? error : new Error(String(error));
          resolve({ success: false, error: err.message, isError: true });
        }
      }
    });
  }

  /** Abort a running script when the agent's turn dies underneath it. */
  private abortAgentScript(agentName: string, reason: string): void {
    const runner = this.codeExecutionRunners.get(agentName);
    if (runner?.busy) {
      runner.abort(reason);
    }
  }

  private toMembraneToolResult(
    callId: string,
    afResult: ToolResult,
    maxChars?: number,
    /** Pre-spilled outcome from the history path — used for the non-image
     *  path so the live wire copy byte-matches what the window stored. */
    precomputed?: { text: string; filePath: string | null },
  ): MembraneToolResult {
    if (afResult.isError) {
      // Same spill policy as successes: reuse the history copy so a giant
      // error string stays bounded on the wire too (byte-matched).
      return {
        toolUseId: callId,
        content: precomputed?.text ?? truncateForHistory(
          afResult.error ?? 'Unknown error', DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS),
        isError: true,
      };
    }
    // MCPL tool results arrive as `data: McpToolResultContent[]` — preserve image
    // blocks natively rather than JSON-stringifying them away. Anything else
    // (objects, scalars) falls through to JSON. The error path was handled
    // above, so isError is always false on these return paths.
    const blocks = this.tryNativeToolResultContent(afResult.data, maxChars, precomputed?.filePath ?? null);
    if (blocks) {
      return { toolUseId: callId, content: blocks, isError: false };
    }
    if (precomputed !== undefined) {
      return { toolUseId: callId, content: precomputed.text, isError: false };
    }
    // JSON.stringify returns the VALUE undefined (not a string) for undefined
    // input — a module tool returning `{ success: true }` with no data would
    // otherwise make `content.length` below throw a TypeError mid-turn.
    let content = JSON.stringify(afResult.data) ?? '';
    if (maxChars && content.length > maxChars) {
      content = safeSlice(content, 0, maxChars)
        + '\n\n[truncated — original was ' + content.length + ' chars]';
    }
    return { toolUseId: callId, content, isError: false };
  }

  /**
   * If `data` is an MCP tool-result content array carrying at least one image,
   * convert to Membrane's native ToolResultContentBlock[]. Returns null when
   * the array is text-only (let JSON path handle it; saves a code path).
   * `maxChars`, when provided, caps each accompanying text block so an image
   * inlined alongside an enormous text payload can't blow the context.
   */
  private tryNativeToolResultContent(
    data: unknown,
    maxChars?: number,
    /** Spill file written by the history path — referenced from truncation
     *  notices so an image-adjacent giant text block stays recoverable. */
    spillPath: string | null = null,
  ): ToolResultContentBlock[] | null {
    if (!Array.isArray(data)) return null;
    let hasImage = false;
    const blocks: ToolResultContentBlock[] = [];
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') return null;
      const b = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        let text = b.text;
        if (maxChars && text.length > maxChars) {
          text = safeSlice(text, 0, maxChars)
            + '\n\n[truncated — original was ' + text.length + ' chars'
            + (spillPath ? `; full serialized result: workspace file ${spillPath}` : '')
            + ']';
        }
        blocks.push({ type: 'text', text });
      } else if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string') {
        hasImage = true;
        blocks.push({
          type: 'image',
          source: { type: 'base64', data: b.data, mediaType: b.mimeType },
        });
      } else {
        return null; // unknown shape — bail to JSON path
      }
    }
    return hasImage ? blocks : null;
  }

  /** Strategy-derived per-message bound (maxMessageTokens * 4 chars). */
  private strategyDerivedToolResultChars(agent: Agent): number | undefined {
    const strategy = agent.getContextManager().getStrategy();
    const maxTokens = strategy.maxMessageTokens;
    if (maxTokens && maxTokens > 0) return maxTokens * 4;
    return undefined;
  }

  /**
   * Effective tool-result inline cap for an agent, with provenance. Desired
   * value: resident's durable agent_settings value → residence
   * FrameworkConfig.toolResultInlineMaxChars → house default (24000).
   * Effective value: min(desired, strategy bound) for EVERY source — the
   * strategy's per-message safety limit is a ceiling, not a suggestion
   * (Sol's #94 ruling: a durable preference must not be a durable path for
   * one tool result to exceed maxMessageTokens; the way to see the whole
   * result is the spill file, not an over-bound blob in live context).
   */
  private resolveToolResultInlineCap(agent: Agent): {
    cap: number;
    source: 'agent-settings-override' | 'framework-config' | 'default';
    /** Set when the desired value was reduced to the strategy bound. */
    clampedBy: 'strategy-bound' | null;
  } {
    const override = this.toolResultInlineMaxCharsOverride.get(agent.name);
    const configured = this.toolResultInlineMaxCharsConfig;
    const desired = override ?? configured ?? DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS;
    const source = override !== undefined
      ? 'agent-settings-override' as const
      : configured !== null ? 'framework-config' as const : 'default' as const;
    const strategyBound = this.strategyDerivedToolResultChars(agent);
    const clamped = strategyBound !== undefined && strategyBound < desired;
    return {
      cap: clamped ? strategyBound : desired,
      source,
      clampedBy: clamped ? 'strategy-bound' : null,
    };
  }

  private approximateDecodedBase64Bytes(base64: string): number {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
  }

  private sanitizeProcessLogValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value && typeof value === 'object') {
      const seenValue = seen.get(value);
      if (seenValue) return seenValue;
    }
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      seen.set(value, clone);
      for (const item of value) {
        clone.push(this.sanitizeProcessLogValue(item, seen));
      }
      return clone;
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    if (record.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string') {
      const clone: Record<string, unknown> = {};
      seen.set(value, clone);
      for (const [key, child] of Object.entries(record)) {
        if (key === 'data' || key === 'mimeType') continue;
        clone[key] = this.sanitizeProcessLogValue(child, seen);
      }
      clone.type = 'image';
      clone.mimeType = record.mimeType;
      clone.approxByteLength = this.approximateDecodedBase64Bytes(record.data);
      clone.redacted = true;
      return clone;
    }

    const clone: Record<string, unknown> = {};
    seen.set(value, clone);
    for (const [key, child] of Object.entries(record)) {
      clone[key] = this.sanitizeProcessLogValue(child, seen);
    }
    return clone;
  }

  private logInference(entry: InferenceLogEntry): void {
    // Store large request/response as blobs
    const entryToStore = { ...entry };

    // Blob threshold: 10KB - typical context-heavy requests exceed this
    const BLOB_THRESHOLD = 10000;

    if (entry.request && typeof entry.request === 'object') {
      const requestJson = JSON.stringify(entry.request);
      if (requestJson.length > BLOB_THRESHOLD) {
        const blobId = this.store.storeBlob(Buffer.from(requestJson), 'application/json');
        entryToStore.request = { blobId };
      }
    }

    if (entry.response && typeof entry.response === 'object') {
      const responseJson = JSON.stringify(entry.response);
      if (responseJson.length > BLOB_THRESHOLD) {
        const blobId = this.store.storeBlob(Buffer.from(responseJson), 'application/json');
        entryToStore.response = { blobId };
      }
    }

    // Append one record per inference. A read-modify-write via setStateJson
    // would emit a whole-array Set — record size then grows with accumulated
    // history (O(n²) aggregate disk) and the append_log strategy registered
    // for this state never sees an append.
    this.store.appendToStateJson(INFERENCE_LOG_ID, entryToStore);
  }

  private logProcessEvent(event: ProcessEvent, responses: ModuleProcessResponse[]): void {
    const entry: ProcessLogEntry = {
      timestamp: Date.now(),
      processEvent: this.sanitizeProcessLogValue(event) as ProcessEvent,
      responses: this.sanitizeProcessLogValue(responses) as ModuleProcessResponse[],
    };

    // Blob threshold: 10KB
    const BLOB_THRESHOLD = 10000;

    const entryToStore = { ...entry };
    const responsesJson = JSON.stringify(entry.responses);
    if (responsesJson.length > BLOB_THRESHOLD) {
      const blobId = this.store.storeBlob(Buffer.from(responsesJson), 'application/json');
      entryToStore.responses = { blobId };
    }

    // Append one record per event — same rationale as logInference.
    this.store.appendToStateJson(PROCESS_LOG_ID, entryToStore);
  }

  /**
   * Find the MCPL server for a tool call by checking against the prefix map.
   * Returns [serverId, prefix] if found, null otherwise.
   */
  private resolveMcplTool(toolName: string): [string, string] | null {
    for (const [prefix, serverId] of this.mcplPrefixMap) {
      if (toolName.startsWith(prefix + '--')) {
        return [serverId, prefix];
      }
    }
    return null;
  }

  private dispatchToolCall(agentName: string, call: ToolCall): void {
    // Enrich call with caller identity so modules can resolve the calling agent
    const enrichedCall: ToolCall = { ...call, callerAgentName: agentName };

    // Route MCPL tool calls to the appropriate server via prefix map
    const mcplMatch = this.resolveMcplTool(enrichedCall.name);
    if (mcplMatch && this.mcplServerRegistry) {
      this.dispatchMcplToolCall(agentName, enrichedCall, mcplMatch[0], mcplMatch[1]);
      return;
    }

    // Route synthesized channel tools
    if (enrichedCall.name.startsWith('channel_') && this.channelRegistry) {
      this.dispatchChannelToolCall(agentName, enrichedCall);
      return;
    }

    // Route the agent's typed, allowlisted hot-settings surface.
    if (enrichedCall.name === 'utils') {
      this.dispatchUtilsToolCall(agentName, enrichedCall);
      return;
    }

    if (enrichedCall.name === 'agent_settings') {
      this.dispatchAgentSettingsToolCall(agentName, enrichedCall);
      return;
    }

    if (enrichedCall.name === 'save_recent_image') {
      this.dispatchSaveImageToolCall(agentName, enrichedCall);
      return;
    }

    if (enrichedCall.name === 'read_image') {
      this.dispatchReadImageToolCall(agentName, enrichedCall);
      return;
    }

    // Route gate_status tool
    if (enrichedCall.name === 'gate_status' && this.eventGate) {
      this.dispatchGateToolCall(agentName, enrichedCall);
      return;
    }

    // Route sleep / wake tools
    if ((enrichedCall.name === 'sleep' || enrichedCall.name === 'wake') && this.eventGate) {
      this.dispatchSleepToolCall(agentName, enrichedCall);
      return;
    }

    // Route wake-rule tools (runtime gate.json policy add/remove)
    if ((enrichedCall.name === 'wake_add_rule' || enrichedCall.name === 'wake_remove_rule') && this.eventGate) {
      this.dispatchWakeRuleToolCall(agentName, enrichedCall);
      return;
    }

    // Route event_tags (tag/ontology discovery)
    if (enrichedCall.name === 'event_tags' && this.eventGate) {
      this.dispatchEventTagsToolCall(agentName, enrichedCall);
      return;
    }

    // Route synthesized 'think' (private reasoning) and 'skip_reply' (deliberate
    // stay-silent) tools — handled by the channel registry like the other
    // synthesized channel tools, but they aren't `channel_`-prefixed so they
    // need an explicit route here.
    if ((enrichedCall.name === 'think' || enrichedCall.name === 'skip_reply') && this.channelRegistry) {
      // skip_reply(wake_in_seconds): arm a gate self-wake so "not replying
      // NOW" can also mean "back in a moment" — ends the turn, then wakes
      // the agent after N seconds unless something else wakes it first
      // (any turn start cancels the pending self-wake). Armed here because
      // the framework owns the EventGate; the registry only words the
      // confirmation. Without a gate the field is stripped so that
      // confirmation never claims a wake that can't happen.
      if (enrichedCall.name === 'skip_reply') {
        const inputObj = (enrichedCall.input ?? {}) as Record<string, unknown>;
        const secs = Number(inputObj.wake_in_seconds);
        const wants = inputObj.wake_in_seconds !== undefined && Number.isFinite(secs) && secs > 0;
        if (wants && this.eventGate) {
          const { inMs } = this.eventGate.armSelfWake(agentName, secs, 'skip_reply');
          console.error(`[self-wake] agent=${agentName} armed in ${Math.round(inMs / 1000)}s (skip_reply)`);
        } else if (inputObj.wake_in_seconds !== undefined && !this.eventGate) {
          delete inputObj.wake_in_seconds;
          console.error(`[self-wake] agent=${agentName} wake_in_seconds requested but no EventGate — ignored`);
        }
      }
      this.dispatchChannelToolCall(agentName, enrichedCall);
      return;
    }

    // Client-side programmatic tool calling: run a python script that calls
    // the agent's other tools in-process (script-inner calls come back through
    // this very dispatcher with waiter-tracked call IDs).
    if (enrichedCall.name === CODE_EXECUTION_TOOL_NAME && this.codeExecutionConfig) {
      this.dispatchCodeExecutionToolCall(agentName, enrichedCall);
      return;
    }

    // prose_help: on-demand routing reference for explicit-prose agents.
    // Answered inline — the grammar is a tool RESULT (model-requested), never
    // ambient context (see PROSE_ROUTING_HELP / teach-by-bounce).
    if (enrichedCall.name === 'prose_help') {
      this.emitTrace({ type: 'tool:completed', module: 'framework', tool: 'prose_help', callId: enrichedCall.id, durationMs: 0 });
      this.pushEvent({
        type: 'tool-result',
        callId: enrichedCall.id,
        agentName,
        moduleName: 'framework',
        result: { success: true, data: PROSE_ROUTING_HELP },
      });
      return;
    }

    const sepIndex = enrichedCall.name.indexOf('--');
    const moduleName = sepIndex >= 0 ? enrichedCall.name.substring(0, sepIndex) : 'unknown';
    const toolName = sepIndex >= 0 ? call.name.substring(sepIndex + 2) : call.name;

    this.pushEvent({
      type: 'tool-call',
      callId: call.id,
      agentName,
      moduleName,
      toolName,
      call,
    });
  }


  private dispatchToolCallEvent(event: ToolCallEvent): void {
    const { call, agentName, moduleName } = event;
    this.emitTrace({
      type: 'tool:started',
      module: moduleName,
      tool: call.name,
      callId: call.id,
      input: call.input,
    });

    const startTime = Date.now();

    this.moduleRegistry
      .handleToolCall(call)
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({
          type: 'tool:completed',
          module: moduleName,
          tool: call.name,
          callId: call.id,
          durationMs,
        });

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName,
          result,
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({
          type: 'tool:failed',
          module: moduleName,
          tool: call.name,
          callId: call.id,
          error: err.message,
          stack: err.stack,
        });

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName,
          result: {
            success: false,
            error: err.message,
            isError: true,
          },
        });
      });
  }

  private addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata
  ): MessageId {
    // Route to the primary agent's context manager (not ephemeral subagents).
    const agent = this.primaryAgentName
      ? this.agents.get(this.primaryAgentName)
      : this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }

    // Defer non-tool_result messages while a tool cycle is mid-flight
    // (pendingAssistantBlocks: preserves tool_use → tool_result adjacency)
    // OR while the target agent has a turn in progress AT ALL. A message
    // stored mid-turn lands BEFORE the turn's assistant blocks in the window
    // even though the live conversation never saw it — so the next compile
    // diverges from the live prefix (prompt-cache bust), the message misses
    // mid-turn injection, and the window falsely testifies the agent saw it
    // and moved on. Turn-alive (activeTurnTokens) is the guard, not stream-
    // alive: a turn exists from dequeue through hooks + compile before its
    // stream registers in activeStreams, and the 2026-07-31 Mythos incident
    // was precisely a deferred flush landing inside that compile window.
    // (activeStreams is kept as a belt-and-suspenders backstop.) Deferred
    // messages flush at the next turn's START (before its compile — riding
    // their own wake), at the agent's next tool boundary (where they are
    // ALSO injected into the live stream — hear-while-acting), or in
    // driveStream's finally when the turn ends.
    const hasToolResult = content.some(b => b.type === 'tool_result');
    if (
      !hasToolResult &&
      (this.pendingAssistantBlocks.size > 0 ||
        this.activeTurnTokens.has(agent.name) ||
        this.activeStreams.has(agent.name))
    ) {
      this.deferredMessages.push({ participant, content, metadata });
      return '' as MessageId; // Deferred — flushed at the next boundary
    }

    return agent.getContextManager().addMessage(participant, content, metadata);
  }

  private editMessage(id: MessageId, content: ContentBlock[]): void {
    const agent = this.primaryAgentName
      ? this.agents.get(this.primaryAgentName)
      : this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }
    agent.getContextManager().editMessage(id, content);
  }

  private removeMessage(id: MessageId): void {
    const agent = this.primaryAgentName
      ? this.agents.get(this.primaryAgentName)
      : this.agents.values().next().value;
    if (!agent) {
      throw new Error('No agents configured');
    }
    agent.getContextManager().removeMessage(id);
  }

  private getMessage(id: MessageId): StoredMessage | null {
    const agent = this.primaryAgentName
      ? this.agents.get(this.primaryAgentName)
      : this.agents.values().next().value;
    if (!agent) {
      return null;
    }
    return agent.getContextManager().getMessage(id);
  }

  private queryMessages(filter: MessageQuery): MessageQueryResult {
    const agent = this.primaryAgentName
      ? this.agents.get(this.primaryAgentName)
      : this.agents.values().next().value;
    if (!agent) {
      return { messages: [], totalCount: 0 };
    }
    return agent.getContextManager().queryMessages(filter);
  }

  private createFrameworkState(): FrameworkState {
    return {
      getAgentStatus: (name: string): AgentState | null => {
        const agent = this.agents.get(name);
        return agent?.state ?? null;
      },
      getModule: (name: string): Module | null => {
        return this.moduleRegistry.getModule(name);
      },
      getPendingRequests: (): InferenceRequest[] => {
        return [...this.pendingRequests];
      },
      queueDepth: this.queue.depth,
    };
  }

  private emitTrace(event: { type: TraceEvent['type']; [key: string]: unknown }): void {
    // Centralized inference-health observability. Every terminal failure path
    // funnels through an `inference:exhausted` trace and every successful model
    // response through `inference:completed`, so intercepting here is the one
    // place that reliably sees all outcomes regardless of which code path
    // produced them. In headless/daemon mode no trace client is attached, so
    // without this the only durable record of a failed inference is a field in
    // llm-calls.jsonl — invisible to operator, agent, and monitoring.
    if (event.type === 'inference:exhausted') {
      this.noteInferenceExhausted(
        (event.agentName as string) ?? 'unknown',
        (event.error as string) ?? 'unknown error',
        event.retryable as boolean | undefined,
        event.errorType as string | undefined,
      );
    } else if (event.type === 'inference:completed') {
      // A successful response — even mid-turn between tool calls — proves the
      // agent isn't hard-down; clear its consecutive-failure streak (and the
      // poison-history breaker's rewind budget).
      const name = event.agentName as string | undefined;
      if (name && this.consecutiveInferenceFailures.get(name)) {
        this.consecutiveInferenceFailures.set(name, 0);
      }
      if (name && this.exhaustionRewinds.get(name)) {
        this.exhaustionRewinds.set(name, 0);
      }
    }

    const traceEvent = {
      ...event,
      timestamp: Date.now(),
    } as TraceEvent;

    for (const listener of this.traceListeners) {
      try {
        listener(traceEvent);
      } catch (error) {
        console.error('Trace listener error:', error);
      }
    }
  }

  /**
   * Handle a fully-exhausted inference (the agent could not produce a response
   * this turn, after retries). Severity here is high — the agent can't think
   * at all — yet historically the only durable record was a buried field in
   * llm-calls.jsonl. This surfaces it three ways:
   *
   *   1. stderr  — always, with the underlying API reason. The place an
   *      operator greps; previously empty in headless mode.
   *   2. chronicle marker — a `[inference-failed]` message so the agent itself
   *      learns its turn failed and why (otherwise it's an experiential blank,
   *      indistinguishable from "not addressed"). addMessage does NOT request
   *      inference, so this never causes a retry/wake loop.
   *   3. escalation — after N consecutive failures the agent is hard-down;
   *      log that loudly (a repeated identical failure is the textbook signal).
   *   4. breaker — when the failures are an `invalid_request` (a 400-class
   *      rejection of the history itself, e.g. corrupted tool_use/tool_result
   *      pairing or an oversized attachment), retrying the same context can
   *      never succeed: every new push event wakes the agent onto the same
   *      poisoned history forever. At the hard-down threshold, automatically
   *      quarantine: shed the newest complete exchange (the same forced-rewind
   *      primitive `/unstick` uses — shedNewestTurn never orphans a
   *      tool_use/thinking block) and retry, bounded by the same rewind cap so
   *      the breaker can never eat the whole history.
   */
  /**
   * Live health snapshot for /healthz and doctor tooling: gate state, queued
   * work, per-agent status + last inference activity. Cheap and read-only.
   */
  healthSnapshot(): Record<string, unknown> {
    return {
      at: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      gate: this.eventGate?.inferenceDiagnostics() ?? null,
      pendingRequests: this.pendingRequests.length,
      activeStreams: [...this.activeStreams.keys()],
      agents: [...this.agents.entries()].map(([name, agent]) => ({
        name,
        status: agent.state.status,
        consecutiveInferenceFailures: this.consecutiveInferenceFailures.get(name) ?? 0,
        providerAdmission: (() => {
          const gate = this.providerGates?.get(name);
          const cooldown = this.providerAccelerationCooldowns?.get(name);
          return {
            primaryActive: (gate?.primaryDepth ?? 0) > 0,
            primaryPending: gate?.primaryPending ?? false,
            auxiliaryInFlight: gate?.auxiliaryInFlight ?? 0,
            auxiliaryDeferred: gate?.deferredAuxiliary ?? 0,
            cooldownUntil: cooldown?.until ?? null,
            heldRequests: cooldown?.heldRequests.length ?? 0,
            lastRecovery: this.providerAccelerationLastRecovery?.get(name) ?? null,
          };
        })(),
        lastInference: this.lastInferenceAt.get(name) ?? null,
        refusalStats: this.refusalStats.get(name) ?? null,
      })),
    };
  }

  /** Append a structured JSONL record to logs/failures.log (best-effort).
   *  Durable and independent of journald/unit log redirects — this is what
   *  connectome-doctor and fleet tooling read. Always stamps `at`. Legacy
   *  records carry {at, agent, consecutive, reason}; new records add `kind`
   *  and kind-specific fields (additive only — doctor parses by regex). */
  private logFailure(record: Record<string, unknown>): void {
    try {
      mkdirSync('logs', { recursive: true });
      appendFileSync(
        'logs/failures.log',
        JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n',
      );
    } catch { /* best-effort */ }
  }

  /**
   * Ops alert — the one escalation path for "a human should hear about this":
   * (1) durable failures.log record (unless the caller already wrote one),
   * (2) an `ops:alert` trace so authorized observers get it on the wire,
   * (3) if CONNECTOME_OPS_WEBHOOK is set, a Discord post throttled to one per
   *     (agent, kind) per cooldown window — a persistent failure re-posts
   *     every ~15 min instead of flooding the channel on every occurrence.
   * See connectome docs/observability.md.
   */
  /**
   * Public ops-alert entry point for host-wired alarms that originate
   * OUTSIDE the framework (e.g. context-manager's repeating
   * compression-quarantine klaxon, wired in the host at strategy
   * construction). Same sinks and cooldown as internal alerts:
   * failures.log + ops:alert trace + CONNECTOME_OPS_WEBHOOK.
   */
  notifyOps(
    kind: string,
    agentName: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.opsAlert(kind, agentName, message, { data });
  }

  private opsAlert(
    kind: string,
    agentName: string,
    message: string,
    opts?: { data?: Record<string, unknown>; skipLog?: boolean },
  ): void {
    if (!opts?.skipLog) {
      this.logFailure({ agent: agentName, kind, reason: message, ...opts?.data });
    }
    this.emitTrace({ type: 'ops:alert', kind, agentName, message, data: opts?.data });

    const hook = process.env.CONNECTOME_OPS_WEBHOOK;
    if (!hook) return;
    const key = `${agentName}:${kind}`;
    const now = Date.now();
    if (now - (this.opsAlertLastSent.get(key) ?? 0) < this.opsAlertCooldownMs) return;
    // Stamp BEFORE the async post so a burst can't race past the cooldown.
    this.opsAlertLastSent.set(key, now);
    fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `\u{1F6A8} **${agentName}** ${kind}: ${message.slice(0, 500)}`,
      }),
    }).catch((err) => console.error(
      `[ops-alert] webhook post failed (${key}):`,
      err instanceof Error ? err.message : err,
    ));
  }

  /**
   * Record a model refusal for observability: per-agent stats + a
   * consecutive-refusal streak (exposed via healthSnapshot), a durable
   * failures.log record for EVERY refusal (previously invisible outside
   * stderr), and a throttled ops alert once refusals repeat — one refusal is
   * often survivable (auto-rewind may clear it); two in a row means stuck.
   * The streak is reset by any non-refusal completion in the stream driver.
   */
  private noteRefusal(
    agentName: string,
    category: string,
    tokens?: { input: number; output: number },
  ): number {
    const stats = this.refusalStats.get(agentName)
      ?? { total: 0, byCategory: {}, lastAt: 0, lastCategory: '' };
    stats.total += 1;
    stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;
    stats.lastAt = Date.now();
    stats.lastCategory = category;
    this.refusalStats.set(agentName, stats);

    const streak = (this.refusalStreak.get(agentName) ?? 0) + 1;
    this.refusalStreak.set(agentName, streak);

    this.logFailure({
      agent: agentName,
      kind: 'refusal',
      category,
      streak,
      locus: this.channelRegistry?.buildChannelContext()?.incoming?.channelId ?? null,
      tokens: tokens ?? null,
    });
    if (streak >= 2) {
      this.opsAlert(
        'refusal',
        agentName,
        `refusal streak ${streak}, category=${category}`,
        { skipLog: true, data: { category, streak } },
      );
    }
    return streak;
  }

  /**
   * Classify a terminal inference error for the `inference:exhausted` trace.
   * Single-sourced for every emit site: the downstream breakers (poison-history
   * quarantine, OverBudget drain kick) gate on `errorType`, so classification
   * drift between sites would silently disable a safety net.
   *
   * context-manager's OverBudgetError is recognized by `err.name`: CM does not
   * export the class from its package root, so a cross-package `instanceof` is
   * unavailable — but `name` is set in its constructor and survives the package
   * boundary. Deliberately NOT a message match: the message wording belongs to
   * CM and can be reworded without warning.
   */
  private classifyInferenceError(err: Error): { retryable?: boolean; errorType?: string } {
    if (err instanceof MembraneError) {
      return { retryable: err.retryable, errorType: err.type };
    }
    if (err.name === 'OverBudgetError') {
      return { errorType: 'over_budget' };
    }
    // context-manager's fatal coverage invariant (fix/coverage-invariant-fatal,
    // 2026-07-26): a compile REFUSES rather than shipping a context with
    // silently-dropped messages. Recovery is identical to over_budget — kick
    // the compression drain so summaries cover the un-represented span.
    if (err.name === 'UncoveredDropError') {
      return { errorType: 'context_refusal' };
    }
    return {};
  }

  /**
   * Public entry to the ops-alert pipeline (failures.log + ops:alert trace +
   * throttled webhook) for host-level detectors OUTSIDE the framework's own
   * inference driver — e.g. the host's logging adapter catching refusals on
   * off-path calls (compression/summarizer, maintenance) that noteRefusal
   * never sees. Same per-(agent,kind) cooldown as everything else.
   */
  notifyOpsAlert(kind: string, agentName: string, message: string, data?: Record<string, unknown>): void {
    this.opsAlert(kind, agentName, message, { data });
  }

  private noteInferenceExhausted(
    agentName: string,
    reason: string,
    retryable?: boolean,
    errorType?: string,
  ): void {
    const streak = (this.consecutiveInferenceFailures.get(agentName) ?? 0) + 1;
    this.consecutiveInferenceFailures.set(agentName, streak);
    this.lastInferenceAt.set(agentName, { ...this.lastInferenceAt.get(agentName), failedAt: Date.now(), lastError: reason.slice(0, 300) });

    // (1) Durable stderr line — works in headless/daemon mode with no client.
    console.error(`[inference-failed] agent=${agentName} consecutive=${streak}: ${reason}`);

    // (1b) Machine-greppable durable record, independent of journald/unit log
    // redirects: logs/failures.log under the host's working directory. This is
    // what connectome-doctor reads. Legacy fields kept; `kind` is additive.
    this.logFailure({ agent: agentName, consecutive: streak, reason, kind: 'inference-exhausted' });

    // (2) Agent-facing chronicle marker (no inference triggered → no loop).
    const agent = this.agents.get(agentName);
    if (agent && process.env.SUPPRESS_INFERENCE_FAILED_MARKER !== '1') {
      try {
        agent.getContextManager().addMessage(
          'user',
          [{
            type: 'text',
            text:
              `[inference-failed] Your previous turn did not complete: the model ` +
              `call failed and produced no response, so nothing was sent. Reason: ` +
              `${reason}. If this recurs with the same cause, change approach ` +
              `rather than retrying identically (e.g. drop an oversized attachment ` +
              `or an unsupported setting).`,
          }],
          { system: true, kind: 'inference-failed', reason, consecutive: streak },
        );
      } catch (err) {
        console.error(`[inference-failed] could not record chronicle marker for ${agentName}:`, err);
      }
    }

    // (2b) OverBudget deadlock breaker. When compile fails with
    // OverBudgetError, the normal compression drain never runs: it is driven
    // by successful activity, which the over-budget state prevents - a closed
    // loop with no internal exit. Field data (2026-07-10, resident agent):
    // 36 minutes hard-down, zero self-rescue; only an operator raising the
    // budget externally could break the loop. Break it here instead: kick the
    // strategy drain directly so folding/merging frees space for the next
    // compile. Bounded ticks, best-effort, never throws, one kick per agent
    // at a time (see overBudgetDrainInFlight).
    //
    // Gates on the classified errorType (see classifyInferenceError); the
    // message match is only a fallback for paths that lost the Error object
    // (e.g. a reason string that crossed a serialization boundary). It matches
    // CM's current OverBudgetError wording and MAY rot if CM rewords it — the
    // errorType gate is the one that's load-bearing.
    const overBudget =
      errorType === 'over_budget' ||
      errorType === 'context_refusal' ||
      /exceed hard budget|no summary covers/i.test(reason);
    // Observability: a refused compile means the agent cannot think AT ALL
    // this turn — surface it on the ops-alert pipeline (ops:alert trace +
    // webhook → fleet-watch) immediately, not only at the hard-down streak.
    // The per-(agent,kind) cooldown throttles repeats; failures.log already
    // has the per-exhaustion record from logFailure above.
    if (overBudget) {
      this.opsAlert(
        'context-refusal',
        agentName,
        `compile refused (${errorType ?? 'unclassified'}): ${reason.slice(0, 300)} — ` +
        `drain breaker ${agent ? 'kicking' : 'unavailable (no agent handle)'}; ` +
        `if this persists, raise contextBudgetTokens or overBudgetGraceRatio.`,
        { skipLog: true },
      );
    }
    if (agent && overBudget && !this.overBudgetDrainInFlight.has(agentName)) {
      this.overBudgetDrainInFlight.add(agentName);
      void (async () => {
        let ticks = 0;
        try {
          const cm = agent.getContextManager();
          while (ticks < 8) {
            await cm.tick();
            ticks++;
          }
          console.error(`[inference-failed] drain kicked for ${agentName} (OverBudget breaker, ${ticks} ticks)`);
        } catch (err) {
          console.error(`[inference-failed] drain kick failed for ${agentName} after ${ticks} ticks:`, err);
        } finally {
          this.overBudgetDrainInFlight.delete(agentName);
        }
      })();
    }

    // (3) Hard-down escalation on repeated identical failure.
    if (streak >= this.inferenceFailureEscalationThreshold) {
      console.error(
        `[inference-hard-down] agent=${agentName} has FAILED ${streak} consecutive ` +
        `inferences — it cannot complete a turn. Last reason: ${reason}`,
      );

      // Ops alert (webhook + ops:alert trace), throttled per (agent, kind) —
      // a hard-down agent re-posts every ~15 min, not on every failed retry.
      // failures.log already got the per-exhaustion record above.
      this.opsAlert(
        'hard-down',
        agentName,
        `${streak} consecutive inference failures. Last reason: ${reason}`,
        { skipLog: true },
      );

      // (4) Poison-history breaker: ONLY for `invalid_request` — a 400-class
      // rejection of the history itself. Deliberately NOT keyed on
      // `retryable === false`, which membrane also returns for auth (expired
      // key), abort (deliberate cancel), context_length (compression's job,
      // and shedding newest is the wrong direction), safety and unsupported —
      // none of which mean the history is poisoned, and all of which would
      // otherwise shed good exchanges and stamp a false "the API kept
      // rejecting your history" marker. `retryable` is kept only for the trace.
      void retryable;
      if (errorType === 'invalid_request' && agent) {
        this.quarantinePoisonedHistory(agent, reason);
      }
    }
  }

  /**
   * Automatic poison-history quarantine (the actual "breaker"). Sheds the
   * newest complete exchange from the agent's history — reusing the same
   * primitives as the refusal auto-rewind / `/unstick` (shedNewestTurn +
   * the single consolidated episode marker) — and queues a retry so the
   * rewound history is verified immediately instead of waiting for the next
   * push event to wake the agent onto the same poisoned context.
   *
   * Bounded: at most `refusalHandling.maxRewinds` (default 3, hard cap 10)
   * sheds per failure episode; the budget resets on any successful inference.
   * At the cap (or with nothing left to shed) it stops — the agent stays up
   * and hard-down logging continues, but no further history is consumed.
   */
  private quarantinePoisonedHistory(agent: Agent, reason: string): void {
    const cap = Math.max(1, Math.min(10, agent.refusalHandling?.maxRewinds ?? 3));
    const used = this.exhaustionRewinds.get(agent.name) ?? 0;
    if (used >= cap) {
      console.error(
        `[inference-rewind] agent=${agent.name} rewind cap ${cap} reached — ` +
        `not shedding further history. Manual repair (/unstick or /undo) needed.`,
      );
      return;
    }

    const rec = this.shedNewestTurn(agent);
    if (!rec) {
      console.error(
        `[inference-rewind] agent=${agent.name} has nothing left to shed — ` +
        `history is only system markers. Manual repair needed.`,
      );
      return;
    }

    this.exhaustionRewinds.set(agent.name, used + 1);
    const count = this.updateRewindMarker(agent, truncateReason(reason), 'inference-failure');
    console.error(
      `[inference-rewind] agent=${agent.name} auto-quarantined ${rec.descriptor} ` +
      `(${count} turn(s) shed this episode, cap ${cap}) after non-retryable ` +
      `inference failures — retrying on the rewound history.`,
    );

    // Retry immediately on the repaired history (bounded by the cap above).
    this.pendingRequests.push({
      agentName: agent.name,
      reason: 'inference-failure-rewind-retry',
      source: 'framework',
      timestamp: Date.now(),
    });
  }

  // ==========================================================================
  // MCPL subsystem wiring
  // ==========================================================================

  /**
   * Initialize all MCPL subsystems and connect configured servers.
   * Fail-open: individual server connection failures don't prevent framework startup.
   */
  private async initializeMcpl(
    serverConfigs: McplServerConfig[],
    inferenceRouting?: import('./mcpl/types.js').InferenceRoutingPolicy,
  ): Promise<void> {
    this.mcplServerRegistry = new McplServerRegistry();
    this.featureSetManager = new FeatureSetManager();
    this.hookOrchestrator = new HookOrchestrator(this.mcplServerRegistry, this.featureSetManager);

    // Build prefix map and store configs for tool routing
    for (const config of serverConfigs) {
      const prefix = config.toolPrefix ?? `mcpl--${config.id}`;
      this.mcplPrefixMap.set(prefix, config.id);
      this.mcplServerConfigs.set(config.id, config);
    }

    // Find shouldTriggerInference callback:
    // Per-server callback takes precedence; fall back to EventGate; fall back to no filter.
    const triggerFilter = serverConfigs.find(c => c.shouldTriggerInference)?.shouldTriggerInference
      ?? (this.eventGate ? this.eventGate.asShouldTriggerCallback() : undefined);

    // Push events handler (Step 6)
    this.pushHandler = new PushHandler(
      this.featureSetManager,
      (event) => this.pushEvent(event as unknown as ProcessEvent),
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      triggerFilter,
    );

    // Server-initiated inference router (Step 6)
    this.inferenceRouter = new InferenceRouter(
      this.membrane,
      this.hookOrchestrator,
      this.featureSetManager,
      inferenceRouting ?? null,
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      (serverId, params) => {
        const server = this.mcplServerRegistry!.getServer(serverId);
        server?.sendInferenceChunk(params);
      },
    );

    // Checkpoint manager (Step 8)
    this.checkpointManager = new CheckpointManager(
      this.store,
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
    );

    // Channel registry (Step 7)
    this.channelRegistry = new ChannelRegistry(
      this.mcplServerRegistry,
      this.featureSetManager,
      (event) => this.pushEvent(event),
      (event) => this.emitTrace(event as { type: TraceEvent['type']; [key: string]: unknown }),
      {
        store: this.store,
        sendTypingFn: (serverId, channelId, metadata, op) => {
          const server = this.mcplServerRegistry!.getServer(serverId);
          if (server) {
            server.sendChannelsTyping(channelId, metadata, op);
          }
        },
        shouldTriggerInference: triggerFilter,
        // Route a conversation fork's plain-text speech to its HOME channel, not
        // the process-global most-recent-inbound locus (item 3). The trunk agent
        // has no home entry, so this returns undefined and routeSpeech falls back
        // to defaultPublishChannel. `conversationAgentHomes` is the permanent
        // spawn-time binding; `channelForAgent` is the router's live binding as a
        // belt-and-suspenders fallback.
        homeChannelResolver: (agentName) =>
          this.conversationAgentHomes.get(agentName)
          ?? this.conversationRouter?.channelForAgent(agentName),
        // Route a single TRUNK agent's plain-text speech to the channel that
        // triggered its CURRENT turn (item-3 redux). connectome-host runs every
        // agent as a trunk (it never exposes conversation forks), so without this
        // a reply falls back to the process-global most-recent-inbound locus and
        // a concurrent message in another channel hijacks it. Empty for
        // heartbeat / no-trigger turns → correct global fallback.
        activeChannelResolver: (agentName) => this.activeTriggerChannels.get(agentName),
        // A text-only turn whose speech couldn't be delivered must not vanish
        // silently: record a `[discord-send-failed]` marker in chronicle so the
        // agent sees, on her next turn, that her reply never reached the human.
        // addMessage() alone does not request inference, so this never wakes
        // her (matching the `discord-send-failed-skip` gate intent: context
        // yes, wake no).
        onRouteFailure: ({ channelId, reason, textLen }) => {
          try {
            // Render a human-readable channel name when we can — a bare
            // snowflake in the marker is unresolvable for the agent (the
            // 2026-07-21 incident read as "a stale artifact", not a live
            // failure). The marker is `system: true`, so it is never
            // conversational and never influences routing.
            const label = channelId
              ? this.channelRegistry?.getDescriptor(channelId)?.label
              : undefined;
            const where = channelId
              ? label && label !== channelId
                ? `${label.startsWith('#') ? label : `#${label}`} (${channelId})`
                : channelId
              : 'the channel';
            this.addMessage(
              'user',
              [{
                type: 'text',
                text: `[discord-send-failed] Your previous reply (${textLen} chars) could not be delivered to ${where} (${reason}). It was saved to your archive but the human did not receive it.`,
              }],
              { system: true, kind: 'discord-send-failed', channelId: channelId ?? '', reason },
            );
          } catch (err) {
            console.error('onRouteFailure: failed to record send-failure marker:', err);
          }
        },
        // A channel opened without the agent asking (policy admission or an
        // open forced by delivery) must be announced in the window, with the
        // opt-out named. Routed here so registry-driven opens and framework-
        // driven opens produce the same durable notice.
        onChannelAutoOpened: ({ conversationId, source, channels }) => {
          this.recordChannelAutoOpenNotice(conversationId, channels, source);
        },
      },
    );

    // Host capabilities advertised during the MCP handshake — stored so
    // servers can also be connected later at runtime (connectMcplServer).
    // §5.2: the host advertises what it actually implements. 0.5.0-draft:
    // afterInference is GONE (replaced by inference/lifecycle, §10.5), and
    // the previously under-advertised inferenceRequest + channels — both
    // implemented for years — are declared (AUDIT-001/issue #76 item 12).
    this.mcplHostCapabilities = {
      version: '0.5',
      pushEvents: true,
      contextHooks: {
        beforeInference: true,
      },
      inferenceLifecycle: true,
      // modelInfo is NOT advertised: §12.2's result requires all four of
      // {id, vendor, contextWindow, capabilities} and the host has no
      // truthful source for contextWindow/capabilities (grep: none exists).
      // Advertising a capability answered with a malformed partial response
      // is worse than honest unsupported (Sol, PR #79 re-review). The
      // handler below answers an explicit error rather than hanging (§6.6).
      inferenceRequest: { streaming: true },
      channels: {
        register: true,
        lifecycle: true,
        publish: true,
        incoming: true,
        streaming: true,
        acknowledge: true,
        typing: true,
      },
      featureSets: true,
    } as McplHostCapabilities;

    for (const config of serverConfigs) {
      try {
        // Stage every startup connection with both planes closed. This removes
        // server-order dependence: no early heartbeat/shell push can become
        // model-visible before a later Discord connection has joined the same
        // awareness generation.
        await this.connectMcplServerInternal(config, true);
      } catch (error) {
        if (error instanceof DiscordAwarenessAccountingError) {
          await this.mcplServerRegistry.closeAll();
          throw error;
        }
        // Fail-open: log and continue with remaining servers
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Failed to connect MCPL server "${config.id}":`, err.message);
        // Reaching this catch means no stub was created, so nothing will
        // retry — except in the edge case where addServer succeeded (with a
        // reconnecting stub) and a later setup step threw; config.reconnect
        // is the best cheap approximation of that.
        this.emitTrace({
          type: 'mcpl:server-connect-failed',
          serverId: config.id,
          error: err.message,
          attempt: 0,
          willRetry: config.reconnect === true,
        });
      }
    }

    // Start the durable drain only after all startup connections are staged.
    // The awareness tools/call is written before control-plane registration is
    // flushed, preserving the server-side queue -> registration -> call order.
    const startupBarrier = this.installMcplDataPlaneGate();
    this.releaseMcplDataPlaneGate(startupBarrier);
    try {
      await startupBarrier.promise;
      this.completeMcplDataPlaneGate(startupBarrier);
    } catch (error) {
      await this.mcplServerRegistry.closeAll();
      throw error;
    }

    // Discover tools from all connected servers
    await this.refreshMcplTools();
  }

  /** Reconcile the durable ledger with Chronicle, then deliver every server's work. */
  async syncDiscordAwarenessMarkers(_onlyServerId?: string): Promise<void> {
    if (!this.discordAwarenessOutbox) return;
    // A targeted retry may discover pending work for other Discord servers
    // during reconciliation. Safety is global, so one generation accounts for
    // all pending operations before releasing any MCPL data plane.
    const barrier = this.installMcplDataPlaneGate();
    this.releaseMcplDataPlaneGate(barrier);
    try {
      await barrier.promise;
      this.completeMcplDataPlaneGate(barrier);
    } catch (error) {
      await this.failMcplDataPlaneGate(barrier, 'explicit synchronization', error);
      throw error;
    }
  }

  private async resumePreparedDiscordSuppressions(): Promise<void> {
    if (!this.discordAwarenessOutbox) return;
    const batches = this.discordAwarenessOutbox.preparedSuppressionsForBranch(
      this.store.currentBranch().name,
      this.store.listBranches(),
    );
    for (const batch of batches) {
      const agent = this.agents.get(batch.agentName);
      if (!agent) {
        throw new Error(
          `Cannot resume Discord suppression ${batch.id}: agent ${batch.agentName} is not configured`,
        );
      }
      const cm = agent.getContextManager();
      for (const interval of [...(batch.suppressionIntervals ?? [])].reverse()) {
        const from = cm.getMessage(interval.fromId as MessageId);
        const to = cm.getMessage(interval.toId as MessageId);
        if (!from && !to) continue; // This interval committed before the crash.
        if (!from || !to) {
          throw new Error(
            `Cannot safely resume Discord suppression ${batch.id}: interval ` +
              `${interval.fromId}..${interval.toId} is only partially present`,
          );
        }
        if (interval.fromId === interval.toId) cm.removeMessage(from.id);
        else cm.removeMessages(from.id, to.id);
      }
      this.discordAwarenessOutbox.activate(batch.id);
      console.error(`[discord-awareness] resumed suppression batch ${batch.id}`);
    }
  }

  /**
   * Deliver every due ref independently. Permanent Discord failures are kept
   * in the ledger for audit but do not block later operations; retryable
   * failures remain pending for the next reconnect/list-change attempt.
   */
  private drainDiscordAwarenessOutbox(
    serverId: string,
  ): Promise<DiscordAwarenessDrainOutcome> {
    if (!this.discordAwarenessOutbox) {
      return Promise.resolve({ status: 'delivered', delivered: 0, failed: 0 });
    }
    const existing = this.discordAwarenessDrains.get(serverId);
    if (existing) return existing;

    const drain = (async () => {
      const connection = this.mcplServerRegistry?.getServer(serverId);
      if (!connection?.isConnected) {
        const operations = this.readDiscordAwarenessPending(serverId);
        for (const operation of operations) {
          this.writeDiscordAwarenessFailure(
            operation.batchId,
            operation.ref,
            operation.action,
            'Awareness delivery not attempted: MCPL connection unavailable',
            false,
          );
        }
        if (operations.length > 0) {
          console.error(
            `[discord-awareness] ${serverId}: connection unavailable; ` +
              `durably deferred=${operations.length}`,
          );
        }
        return { status: 'unavailable' as const, accounted: operations.length };
      }

      let delivered = 0;
      let failed = 0;
      const attempted = new Set<string>();
      while (true) {
        const operations = this.readDiscordAwarenessPending(serverId).filter((operation) => {
          const key = `${operation.batchId}\0${operation.ref.channelId}\0${operation.ref.messageId}\0${operation.action}`;
          if (attempted.has(key)) return false;
          attempted.add(key);
          return true;
        });
        if (operations.length === 0) break;
        for (const operation of operations) {
          const ref = operation.ref;
          const channelId = ref.channelId.startsWith('discord:')
            ? ref.channelId.split(':').at(-1)!
            : ref.channelId;
          let deliveryError: string | undefined;
          try {
            const tool = operation.action === 'add' ? 'add_reaction' : 'remove_reaction';
            const result = await connection.sendToolsCallWithDeadline(tool, {
              channelId,
              messageId: ref.messageId,
              emoji: operation.emoji,
            }, this.discordAwarenessDeadlineMs);
            if (result.isError) {
              deliveryError = result.content
                .map((content) => content.text ?? '')
                .filter(Boolean)
                .join('; ') || `Discord ${tool} returned an error`;
            }
          } catch (error) {
            deliveryError = error instanceof Error ? error.message : String(error);
          }

          if (deliveryError !== undefined) {
            const permanent = isPermanentDiscordReactionFailure(deliveryError);
            this.writeDiscordAwarenessFailure(
              operation.batchId,
              ref,
              operation.action,
              deliveryError,
              permanent,
            );
            failed++;
            console.error(
              `[discord-awareness] ${operation.action} failed for ${ref.channelId}/${ref.messageId}` +
                ` (${permanent ? 'permanent' : 'retryable'}): ${deliveryError}`,
            );
          } else {
            this.writeDiscordAwarenessSuccess(operation.batchId, ref, operation.action);
            delivered++;
          }
        }
      }
      if (delivered > 0 || failed > 0) {
        console.error(
          `[discord-awareness] ${serverId}: delivered=${delivered} failed=${failed}`,
        );
      }
      return { status: 'delivered' as const, delivered, failed };
    })().finally(() => {
      this.discordAwarenessDrains.delete(serverId);
    });

    this.discordAwarenessDrains.set(serverId, drain);
    return drain;
  }

  private readDiscordAwarenessPending(serverId?: string) {
    try {
      return this.discordAwarenessOutbox!.pending(serverId);
    } catch (error) {
      throw new DiscordAwarenessAccountingError(
        `ledger read${serverId ? ` for ${serverId}` : ''}`,
        error,
      );
    }
  }

  private writeDiscordAwarenessSuccess(
    batchId: string,
    ref: import('./recovery/discord-awareness-outbox.js').DiscordAwarenessRef,
    action: import('./recovery/discord-awareness-outbox.js').DiscordAwarenessAction,
  ): void {
    try {
      this.discordAwarenessOutbox!.recordSuccess(batchId, ref, action);
    } catch (error) {
      throw new DiscordAwarenessAccountingError('recordSuccess ledger write', error);
    }
  }

  private writeDiscordAwarenessFailure(
    batchId: string,
    ref: import('./recovery/discord-awareness-outbox.js').DiscordAwarenessRef,
    action: import('./recovery/discord-awareness-outbox.js').DiscordAwarenessAction,
    errorMessage: string,
    permanent: boolean,
  ): void {
    try {
      this.discordAwarenessOutbox!.recordFailure(
        batchId,
        ref,
        action,
        errorMessage,
        permanent,
      );
    } catch (error) {
      throw new DiscordAwarenessAccountingError('recordFailure ledger write', error);
    }
  }

  private beginDiscordAwarenessBarrier(): {
    requiresBarrier: boolean;
    promise: Promise<DiscordAwarenessDrainOutcome>;
  } {
    if (!this.discordAwarenessOutbox) {
      return {
        requiresBarrier: false,
        promise: Promise.resolve({ status: 'delivered', delivered: 0, failed: 0 }),
      };
    }
    try {
      this.discordAwarenessOutbox.reconcileForBranch(
        this.store.currentBranch().name,
        this.store.listBranches(),
      );
    } catch (error) {
      throw new DiscordAwarenessAccountingError('branch reconciliation', error);
    }
    const pending = this.readDiscordAwarenessPending();
    if (pending.length === 0) {
      return {
        requiresBarrier: false,
        promise: Promise.resolve({ status: 'delivered', delivered: 0, failed: 0 }),
      };
    }
    const serverIds = [...new Set(pending.map((operation) => operation.ref.serverId))];
    const promise = Promise.all(
      serverIds.map((serverId) => this.drainDiscordAwarenessOutbox(serverId)),
    ).then((outcomes): DiscordAwarenessDrainOutcome => {
      if (outcomes.every((outcome) => outcome.status === 'unavailable')) {
        return {
          status: 'unavailable',
          accounted: outcomes.reduce(
            (count, outcome) => count + (outcome.status === 'unavailable' ? outcome.accounted : 0),
            0,
          ),
        };
      }
      return {
        status: 'delivered',
        delivered: outcomes.reduce(
          (count, outcome) => count + (outcome.status === 'delivered' ? outcome.delivered : 0),
          0,
        ),
        failed: outcomes.reduce(
          (count, outcome) => count + (outcome.status === 'delivered' ? outcome.failed : 0),
          0,
        ),
      };
    });
    return { requiresBarrier: true, promise };
  }

  /**
   * Install one framework-global Discord-awareness generation before releasing
   * any inference-bearing event. With pending work, every MCPL data plane is
   * paused while all control planes remain live. With no pending work, ready()
   * runs synchronously so request responders preserve their historical
   * same-stack behavior.
   */
  private installMcplDataPlaneGate(): DiscordAwarenessBarrier {
    for (const connection of this.mcplServerRegistry?.getAllServers() ?? []) {
      connection.pauseDataPlane();
    }
    const generation = ++this.discordAwarenessBarrierGeneration;

    let begun: ReturnType<AgentFramework['beginDiscordAwarenessBarrier']>;
    try {
      begun = this.beginDiscordAwarenessBarrier();
    } catch (error) {
      begun = {
        requiresBarrier: true,
        promise: Promise.reject(error),
      };
    }
    const barrier: DiscordAwarenessBarrier = { generation, ...begun };
    this.discordAwarenessBarrier = barrier;
    return barrier;
  }

  private releaseMcplDataPlaneGate(
    barrier: DiscordAwarenessBarrier,
  ): void {
    if (this.discordAwarenessBarrier !== barrier) return;
    if (barrier.requiresBarrier) {
      for (const connection of this.mcplServerRegistry?.getAllServers() ?? []) {
        connection.readyControlPlane();
      }
      return;
    }
    this.completeMcplDataPlaneGate(barrier);
  }

  private completeMcplDataPlaneGate(
    barrier: DiscordAwarenessBarrier,
  ): boolean {
    if (this.discordAwarenessBarrier !== barrier) return false;
    this.discordAwarenessBarrier = null;
    for (const connection of this.mcplServerRegistry?.getAllServers() ?? []) {
      // ready() can synchronously flush a nested list-change notification that
      // installs a newer global generation. Never let this older completion
      // release any remaining server behind that newer gate.
      if (this.discordAwarenessBarrier !== null) return false;
      connection.ready();
    }
    return this.discordAwarenessBarrier === null;
  }

  private async failMcplDataPlaneGate(
    barrier: DiscordAwarenessBarrier,
    context: string,
    error: unknown,
  ): Promise<void> {
    if (this.discordAwarenessBarrier !== barrier) return;
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[discord-awareness] ${context} failed globally:`, err.message);
    const connections = this.mcplServerRegistry?.getAllServers() ?? [];
    for (const connection of connections) {
      this.emitTrace({
        type: 'mcpl:server-error',
        serverId: connection.id,
        error: `Discord awareness accounting unhealthy: ${err.message}`,
      });
    }
    await Promise.all(connections.map(async (connection) => {
      await connection.reconnectAfterFailure().catch((closeError) => {
        console.error(
          `[discord-awareness] could not recycle unhealthy connection ${connection.id}:`,
          closeError instanceof Error ? closeError.message : closeError,
        );
      });
    }));
  }

  /**
   * Connect a single MCPL server: register routing entries, open the
   * connection, wire events, and initialize feature sets / scopes /
   * checkpoints. Shared by startup (initializeMcpl) and the runtime
   * lifecycle API (connectMcplServer). Throws on connection failure.
   */
  private async connectMcplServerInternal(
    config: import('./mcpl/types.js').McplServerConfig,
    deferAwareness = false,
  ): Promise<void> {
    if (!this.mcplServerRegistry || !this.mcplHostCapabilities) {
      throw new Error('MCPL subsystem is not initialized');
    }

    // Register prefix + config for tool dispatch routing (idempotent with
    // the pre-registration pass in initializeMcpl).
    const prefix = config.toolPrefix ?? `mcpl--${config.id}`;
    this.mcplPrefixMap.set(prefix, config.id);
    this.mcplServerConfigs.set(config.id, config);

    // Record per-server channel subscription policy before the server
    // registers channels — handleRegister fires during the handshake.
    if (this.channelRegistry) {
      this.channelRegistry.setSubscriptionPolicy(
        config.id,
        config.channelSubscription ?? 'manual',
      );
    }

    const connection = await this.mcplServerRegistry.addServer(config, this.mcplHostCapabilities);

    // Wire listeners before either startup staging or the runtime global gate
    // releases control traffic needed for registration and marker service.
    this.wireMcplEvents(connection);

    if (deferAwareness) {
      // Staged startup: both planes are closed, so the §5.3 policy
      // round-trip cannot let any buffered traffic slip — establish the
      // grant now, before staging ever releases.
      await this.registerMcplServerFeatures(config, connection);
      this.emitTrace({ type: 'module:added', moduleName: `mcpl:${config.id}` });
      return;
    }

    const awarenessBarrier = this.installMcplDataPlaneGate();
    // NO early release: both planes stay closed through accounting AND the
    // §5.3 policy round-trip below (PR #79 review blocker 3 — the early
    // control flush released channels-register/changed before any grant
    // existed). The awareness drain rides tools/call RESPONSES, which are
    // never event-buffered, so it needs no plane release to make progress.
    try {
      await awarenessBarrier.promise;
    } catch (error) {
      // Startup cannot fail open on a broken awareness ledger. Disable the
      // reconnecting stub/connection before propagating the distinct error to
      // initializeMcpl, which tears down any other servers and aborts create().
      // Ordering matters: awareness accounting settles BEFORE the §5.3
      // policy round-trip below, so an accounting failure aborts with the
      // grant still empty and every buffered event still behind the gate —
      // a failed startup never reports a released data plane. (The reverse
      // order let a push arrive during the policy await and get flushed by
      // teardown.)
      await connection.close().catch(() => {});
      throw error;
    }

    // §5.3 initial policy handshake — after accounting, before the gate
    // completes: the grant is established (or knowingly left empty) before
    // ANY buffered traffic (control or data) flows. complete() then
    // ready()s both planes through the admission gate.
    await this.registerMcplServerFeatures(config, connection);
    this.completeMcplDataPlaneGate(awarenessBarrier);

    this.emitTrace({ type: 'module:added', moduleName: `mcpl:${config.id}` });
  }

  /** Per-connection §17.8 fetch limiter: at most one in-flight fetch, at
   *  most one queued behind it (announcements coalesce), floor between
   *  completed fetches. Exceeding the floor drops the excess with a
   *  diagnostic — the host bounds the rate; it never depends on server
   *  coalescing. */
  private manifestRefreshState: Map<string, { inFlight: boolean; queued: boolean; lastCompletedAt: number }> = new Map();
  private static readonly MANIFEST_FETCH_FLOOR_MS = 5_000;

  /**
   * §17.5 host processing: fetch the complete manifest, validate exactly as
   * at initialize, diff, apply §6.7 consequences (removals eagerly even
   * when other declarations are invalid; additions only through
   * tell→receipt→activate), emit ONE change receipt (§17.6).
   */
  private async handleManifestChanged(
    connection: McplServerConnection,
    announce: { revision?: string; domains?: string[] },
  ): Promise<void> {
    const st = this.manifestRefreshState.get(connection.id)
      ?? { inFlight: false, queued: false, lastCompletedAt: 0 };
    this.manifestRefreshState.set(connection.id, st);
    if (st.inFlight) {
      // Coalesce: one queued refresh re-runs after the current fetch — the
      // fetch is always of the CURRENT manifest, so N announcements need at
      // most one trailing fetch (§17.8).
      st.queued = true;
      return;
    }
    const sinceLast = Date.now() - st.lastCompletedAt;
    if (sinceLast < AgentFramework.MANIFEST_FETCH_FLOOR_MS) {
      if (!st.queued) {
        st.queued = true;
        setTimeout(() => {
          const cur = this.manifestRefreshState.get(connection.id);
          if (cur?.queued && !cur.inFlight) {
            cur.queued = false;
            void this.handleManifestChanged(connection, announce).catch(() => {});
          }
        }, AgentFramework.MANIFEST_FETCH_FLOOR_MS - sinceLast).unref?.();
      }
      return;
    }

    st.inFlight = true;
    try {
      const config = this.mcplServerConfigs.get(connection.id);
      if (!config) return;

      // §17.4 fetch. A server that cannot answer keeps its previous
      // manifest in force — an unparseable/failed fetch teaches nothing and
      // narrows nothing (§17.5 step 1).
      let fetched: import('./mcpl/types.js').McplCapabilities | null;
      try {
        fetched = await connection.sendManifestRequest();
      } catch (err) {
        console.error(`[mcpl] ${connection.id}: mcpl/manifest fetch failed — previous manifest stands (§17.5): ${err instanceof Error ? err.message : err}`);
        return;
      }
      if (!fetched || typeof fetched !== 'object') {
        console.error(`[mcpl] ${connection.id}: mcpl/manifest returned no object — previous manifest stands (§17.5)`);
        return;
      }

      // Validate exactly as at initialize: expand §5.1 shorthand, apply the
      // config mask, recompute the grant. Unknown names mint nothing;
      // invalid declarations fail closed in derivation — and REMOVALS still
      // apply, because the new grant/derivation simply lacks whatever no
      // longer validates (§17.5 step 1's partial-invalid rule falls out of
      // computing forward from the fetched content).
      const expanded = expandAdvertisementShorthand(fetched);
      const { capabilities: masked, dropped } = maskNegotiatedCapabilities(expanded, config);
      const newGrant = computeGrant(masked, config, { mcpToolsAdvertised: connection.mcpToolsAdvertised });

      const oldEffective = new Set(connection.grant.effectiveList());
      const newEffective = new Set(newGrant.effectiveList());
      const revoked = [...oldEffective].filter((p) => !newEffective.has(p)).sort();
      const added = [...newEffective].filter((p) => !oldEffective.has(p)).sort();

      const oldDeclared = Object.keys(this.featureSetManager?.getDeclaredFeatureSets(connection.id) ?? {});
      const oldEnabled = oldDeclared.filter((n) => this.featureSetManager?.isEnabled(connection.id, n));

      // §6.7 REDUCTION FIRST, atomically, before the server is told:
      // security cannot wait on consent. The interim grant is new∩old — no
      // revoked path survives, no added path activates yet.
      const hadReduction = revoked.length > 0;
      if (hadReduction) {
        const interim = new CapabilityGrant(
          new Set([...newEffective].filter((p) => oldEffective.has(p))),
          [...newGrant.deniedPaths],
        );
        connection.establishGrant(interim);
      }

      // PHASE 1 — pre-receipt: live feature state derives from ACTIVE
      // authority (the interim grant when reduced, the standing grant
      // otherwise), never from the unactivated full grant. Feature state
      // must obey the same §6.7 ordering the grant does: a newly added
      // capability-backed feature set cannot be host-enabled while its
      // capability is still absent from the active grant (Sol, PR #84
      // review). Declarations come from the fetched manifest either way —
      // a set absent from the new manifest is gone regardless.
      const cfg = { enabledFeatureSets: config.enabledFeatureSets, disabledFeatureSets: config.disabledFeatureSets };
      const maskedOrEmpty = masked ?? ({ version: '0.5' } as import('./mcpl/types.js').McplCapabilities);
      this.featureSetManager!.initializeServer(connection.id, maskedOrEmpty, cfg, connection.grant);

      // The Request DESCRIBES the proposed new policy — derived from the
      // full new grant on a scratch manager, installing nothing.
      const updateParams = new FeatureSetManager().initializeServer(connection.id, maskedOrEmpty, cfg, newGrant);
      updateParams.effectiveCapabilities = newGrant.effectiveList();
      if (newGrant.deniedPaths.length > 0) updateParams.deniedCapabilities = [...newGrant.deniedPaths];

      // Tell → receipt → activate (§6.7). PHASE 2 by outcome:
      //  accepted  → full grant + full-derived feature state;
      //  refused   → honor fallback: 'close' closes the transport;
      //              'mcp-only' (or absent) = empty grant + empty-derived
      //              feature state, mirroring the §5.3 initial path;
      //  unanswered → interim grant and interim-derived state stand.
      let negotiated = false;
      try {
        const receipt = await connection.sendFeatureSetsUpdateRequest(updateParams);
        if (receipt && receipt.accepted === false) {
          const fallback = receipt.fallback ?? 'mcp-only';
          console.error(`[mcpl] ${connection.id} refused post-manifest policy — fallback: ${fallback}`);
          if (fallback === 'close') {
            await connection.close();
            return;
          }
          connection.establishGrant(CapabilityGrant.empty());
          this.featureSetManager!.initializeServer(connection.id, maskedOrEmpty, cfg, CapabilityGrant.empty());
        } else {
          connection.establishGrant(newGrant);
          this.featureSetManager!.initializeServer(connection.id, maskedOrEmpty, cfg, newGrant);
          connection.manifestState.lastNegotiatedAt = Date.now();
          negotiated = true;
        }
      } catch {
        console.error(`[mcpl] ${connection.id} did not answer post-manifest policy — expansion does not activate (§6.7); interim state stands`);
      }

      // Adopt the validated manifest + tracking. droppedCapabilities is
      // REPLACED unconditionally — an empty new mask must clear stale paths
      // (Sol, PR #84 review).
      connection.capabilities = masked;
      connection.manifestState.lastValidatedRevision =
        typeof (fetched as { revision?: unknown }).revision === 'string'
          ? (fetched as { revision: string }).revision : null;
      connection.manifestState.lastFetchedAt = Date.now();
      connection.droppedCapabilities = new Set(dropped);

      const newDeclared = Object.keys(this.featureSetManager?.getDeclaredFeatureSets(connection.id) ?? {});
      const newEnabled = newDeclared.filter((n) => this.featureSetManager?.isEnabled(connection.id, n));
      const degraded = oldEnabled.filter((n) => !newEnabled.includes(n)).sort();
      const restored = newEnabled.filter((n) => !oldEnabled.includes(n)).sort();

      // §17.6: ONE receipt per manifest change, closed host-derived impact
      // vocabulary, never a server-authored flag.
      const impacts: Array<{ impact: string; subject: string; disposition: string }> = [
        ...revoked.map((p) => ({ impact: 'capability-revoked', subject: p, disposition: 'applied' })),
        ...added.map((p) => ({ impact: 'capability-expansion-pending', subject: p, disposition: negotiated ? 'applied' : 'decision-needed' })),
        ...degraded.map((n) => ({ impact: 'feature-degraded', subject: n, disposition: 'applied' })),
        ...restored.map((n) => ({ impact: 'feature-restored', subject: n, disposition: negotiated ? 'applied' : 'decision-needed' })),
      ];
      this.emitTrace({
        type: 'mcpl:manifest-change-receipt',
        serverId: connection.id,
        revision: connection.manifestState.lastValidatedRevision,
        announcedDomains: announce.domains ?? [],
        impacts,
      });
      this.handleToolsListChanged(connection.id);
    } finally {
      st.inFlight = false;
      st.lastCompletedAt = Date.now();
      if (st.queued) {
        st.queued = false;
        setTimeout(() => { void this.handleManifestChanged(connection, announce).catch(() => {}); },
          AgentFramework.MANIFEST_FETCH_FLOOR_MS).unref?.();
      }
    }
  }

  /**
   * (Re-)establish a server's host-side MCPL registration: feature-set state
   * (plus the featureSets/update sent to the server), scope patterns, and
   * stateful-feature-set checkpoint registration.
   *
   * Called on initial connect (connectMcplServerInternal) AND after every
   * auto-reconnect. The 'close' handler drops the feature-set registration, so
   * without the reconnect re-run FeatureSetManager.validateInbound would throw
   * "Unknown server" forever — every push event and inference request from the
   * revived server silently rejected until a full host restart.
   *
   * CheckpointManager.registerFeatureSet is idempotent (no-op for a key that
   * already has a tree), so checkpoint trees preserved across a transient
   * disconnect are resumed, not reset.
   */
  private async registerMcplServerFeatures(
    config: import('./mcpl/types.js').McplServerConfig,
    connection: McplServerConnection,
  ): Promise<void> {
    if (!connection.capabilities) return;

    // §5.4: compute the effective grant from the (config-masked)
    // advertisement. Not yet active — expansion activates only after the
    // receipt (§6.7); until then the connection's grant is empty and every
    // privileged inbound method is rejected.
    const grant = computeGrant(connection.capabilities, config, { mcpToolsAdvertised: connection.mcpToolsAdvertised });

    const updateParams = this.featureSetManager!.initializeServer(
      config.id,
      connection.capabilities,
      {
        enabledFeatureSets: config.enabledFeatureSets,
        disabledFeatureSets: config.disabledFeatureSets,
      },
      grant,
    );

    // §5.3: initial policy MUST be a Request, MUST precede first fan-out,
    // and MUST be sent even when nothing is enabled or disabled — a server
    // defaulted to fully disabled has to be told. The response is a
    // degradation receipt (§6.7): consequence testimony, never policy
    // authority — nothing in it may widen the grant.
    updateParams.effectiveCapabilities = grant.effectiveList();
    if (grant.deniedPaths.length > 0) {
      updateParams.deniedCapabilities = [...grant.deniedPaths];
    }

    try {
      const receipt = await connection.sendFeatureSetsUpdateRequest(updateParams);
      if (receipt && receipt.accepted === false) {
        const fallback = receipt.fallback ?? 'mcp-only';
        console.error(
          `[mcpl] ${config.id} refused initial policy (${receipt.reason ?? 'no reason'}) — fallback: ${fallback}`,
        );
        if (fallback === 'close') {
          await connection.close();
          return;
        }
        // mcp-only (§3.2): grant stays empty, MCPL privileged surface stays
        // dark, plain MCP tools keep working. MUST NOT widen in response to
        // the refusal — a human can change config; the policy engine cannot.
        return;
      }
      // Expansion activates on receipt (§6.7).
      connection.establishGrant(grant);
      if (receipt?.accepted === true && receipt.mode === 'degraded') {
        for (const uf of receipt.unavailableFeatures ?? []) {
          console.error(
            `[mcpl] ${config.id} degraded: ${uf.featureSet} (${uf.effect}; missing ${uf.missingCapabilities.join(', ')})`,
          );
        }
      }
    } catch (err) {
      // A pre-0.5 server treats the Request as a notification and never
      // answers. §6.7: an unanswered expansion simply does not activate —
      // grant stays empty, connection is effectively MCP-only. This WILL
      // dark every un-migrated MCPL server's privileged surface; accepted
      // deliberately for the single-release rollout (issue #76 item 9).
      console.error(
        `[mcpl] ${config.id} did not answer the initial policy Request — ` +
          `MCPL privileged surface stays disabled (§6.7 unanswered expansion): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    if (config.scopes) {
      console.error(`[mcpl] ${config.id}: config \`scopes\` is ignored — §7 Scoped Access removed in 0.5.0`);
    }

    // Register stateful feature sets with checkpoint manager (Step 8)
    if (this.checkpointManager) {
      const declared = this.featureSetManager!.getDeclaredFeatureSets(config.id);
      if (declared) {
        for (const [fsName, fsDecl] of Object.entries(declared)) {
          if (fsDecl.rollback || fsDecl.hostState) {
            this.checkpointManager.registerFeatureSet(config.id, fsName, {
              hostState: fsDecl.hostState ?? false,
              rollback: fsDecl.rollback ?? false,
            });
          }
        }
      }
    }
  }

  // ==========================================================================
  // Runtime MCPL server lifecycle (agent-facing hot deploy/restart/unload)
  // ==========================================================================

  /**
   * Connect a new MCPL server at runtime. Refreshes the tool list and
   * notifies the agent of newly available tools. Throws if the MCPL
   * subsystem is not initialized, the id is already connected, or the
   * connection/handshake fails.
   */
  async connectMcplServer(
    config: import('./mcpl/types.js').McplServerConfig,
  ): Promise<void> {
    // Lazily bring up the MCPL subsystem — a framework that started with zero
    // configured servers can still deploy its first one at runtime.
    if (!this.mcplServerRegistry || !this.mcplHostCapabilities) {
      await this.initializeMcpl([], this.mcplInferenceRoutingConfig ?? undefined);
    }

    // Same collision rules create() enforces at startup: the tool prefix must
    // not shadow a module name or another server's prefix.
    const prefix = config.toolPrefix ?? `mcpl--${config.id}`;
    if (this.moduleRegistry.getAllModules().some(m => m.name === prefix)) {
      throw new Error(
        `MCPL server "${config.id}" toolPrefix "${prefix}" collides with module "${prefix}"`,
      );
    }
    const prefixOwner = this.mcplPrefixMap.get(prefix);
    if (prefixOwner && prefixOwner !== config.id) {
      throw new Error(
        `MCPL server "${config.id}" toolPrefix "${prefix}" collides with server "${prefixOwner}"`,
      );
    }

    const oldToolNames = new Set(this.mcplTools.map(t => t.name));
    await this.connectMcplServerInternal(config);
    await this.refreshMcplTools();
    this.emitMcplToolDiff(oldToolNames, config.id);
  }

  /**
   * Disconnect an MCPL server at runtime: close the connection, destroy its
   * feature-set and checkpoint state (permanent removal — unlike a transient
   * transport close, which preserves checkpoints for the reconnect), remove
   * its channels from the registry, drop routing entries, and refresh tools.
   * No-op-ish if the server is not connected (still clears routing state).
   */
  async disconnectMcplServer(id: string): Promise<void> {
    if (!this.mcplServerRegistry) {
      throw new Error('MCPL subsystem is not initialized');
    }
    const config = this.mcplServerConfigs.get(id);
    const oldToolNames = new Set(this.mcplTools.map(t => t.name));

    await this.mcplServerRegistry.removeServer(id);
    this.channelRegistry?.removeServer(id);

    // Permanent removal: also destroy feature-set and checkpoint state
    // explicitly. The 'close' handler usually does this, but a connection that
    // already transiently closed (reconnect pending) emits no second 'close'
    // from close(), and the transient path deliberately preserves checkpoints.
    this.featureSetManager?.removeServer(id);
    this.checkpointManager?.removeServer(id);

    const prefix = config?.toolPrefix ?? `mcpl--${id}`;
    this.mcplPrefixMap.delete(prefix);
    this.mcplServerConfigs.delete(id);

    await this.refreshMcplTools();
    this.emitMcplToolDiff(oldToolNames, id);
  }

  /**
   * Restart an MCPL server at runtime: disconnect, then reconnect with the
   * same (or an updated) config. This actually respawns a stdio child —
   * unlike `reconnect: true`, which only retries after transport-level
   * failures. Throws if the server has no stored config and none is given.
   */
  async restartMcplServer(
    id: string,
    newConfig?: import('./mcpl/types.js').McplServerConfig,
  ): Promise<void> {
    const config = newConfig ?? this.mcplServerConfigs.get(id);
    if (!config) {
      throw new Error(`MCPL server "${id}" is not configured`);
    }
    await this.disconnectMcplServer(id);
    await this.connectMcplServer(config);
  }

  /**
   * List configured MCPL servers with live connection status and the number
   * of tools each currently contributes.
   */
  listMcplServers(): Array<{
    id: string;
    connected: boolean;
    retrying: boolean;
    toolPrefix: string;
    toolCount: number;
    /** True only after the §5.3 policy receipt activated the grant. */
    policyEstablished: boolean;
    /** Sole normative authorization allowlist for the connection (§5.4). */
    effectiveGrant: string[];
    /** Advertised paths removed by host enabled/disabled capability config. */
    maskedCapabilities: string[];
    /** Advertised paths removed by a host deny-by-default rule (§13.4). */
    deniedCapabilities: string[];
    /** Host-owned authority; deliberately separate from the portable grant. */
    allowHostCommands: boolean;
    /**
     * Per-transport §17 facts about the last manifest this host fetched and
     * acted on. The revision is server-authored and equality-only; these are
     * not the server's manifestChanged announcements.
     */
    manifestState: {
      lastValidatedRevision: string | null;
      lastFetchedAt: number | null;
      lastNegotiatedAt: number | null;
    };
    command?: string;
    url?: string;
  }> {
    const result: Array<{
      id: string; connected: boolean; retrying: boolean;
      toolPrefix: string; toolCount: number; policyEstablished: boolean;
      effectiveGrant: string[]; maskedCapabilities: string[];
      deniedCapabilities: string[]; allowHostCommands: boolean;
      manifestState: {
        lastValidatedRevision: string | null;
        lastFetchedAt: number | null;
        lastNegotiatedAt: number | null;
      };
      command?: string; url?: string;
    }> = [];
    for (const [id, config] of this.mcplServerConfigs) {
      const prefix = config.toolPrefix ?? `mcpl--${id}`;
      const connection = this.mcplServerRegistry?.getServer(id) ?? null;
      const connected = connection?.isConnected ?? false;
      result.push({
        id,
        connected,
        retrying: !connected && (connection?.willReconnect ?? false),
        toolPrefix: prefix,
        toolCount: this.mcplTools.filter(t => t.name.startsWith(`${prefix}--`)).length,
        policyEstablished: connection?.policyEstablished ?? false,
        effectiveGrant: connection?.grant.effectiveList() ?? [],
        maskedCapabilities: [...(connection?.droppedCapabilities ?? [])].sort(),
        deniedCapabilities: [...(connection?.grant.deniedPaths ?? [])].sort(),
        allowHostCommands: config.allowHostCommands === true,
        manifestState: connection
          ? { ...connection.manifestState }
          : { lastValidatedRevision: null, lastFetchedAt: null, lastNegotiatedAt: null },
        command: config.command,
        url: config.url,
      });
    }
    return result;
  }

  /**
   * Wire event listeners on an MCPL server connection.
   * Push events and inference requests are deferred to Steps 6/7.
   */
  private wireMcplEvents(connection: McplServerConnection): void {
    // Forward subprocess stderr lines as trace events so consumers (conhost,
    // log sinks, TUI badges) can persist and surface them.
    connection.on('stderr', (params: { line: string }) => {
      this.emitTrace({ type: 'mcpl:server-stderr', serverId: connection.id, line: params.line });
    });

    // featureSets/changed is REMOVED in 0.5.0 — the connection answers it
    // -32601 (superseded by SPEC §17's host-diffed manifest fetch); no
    // listener, and nothing mutates declarations off a server-authored
    // change payload.

    // Handle scope elevation requests
    // §7 Scoped Access is removed in 0.5.0. scope/elevate is answered
    // -32601 at the connection (server-connection.ts) and never reaches the
    // framework; the ScopeManager and config `scopes` wiring went with it.

    // Handle push events (Step 6)
    connection.on('push-event', async (
      params: PushEventParams,
      responder?: { respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      const barrier = this.discordAwarenessBarrier;
      if (barrier) await barrier.promise;
      this.pushHandler?.handlePushEvent(connection.id, params, responder as never);
    });

    // Handle server-initiated inference requests (Step 6)
    connection.on('inference-request', async (
      params: McplInferenceRequestParams,
      responder?: { id: string | number; respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      if (this.inferenceRouter && responder) {
        const barrier = this.discordAwarenessBarrier;
        if (barrier) await barrier.promise;
        await this.inferenceRouter.handleInferenceRequest(connection.id, params, {
          respond: responder.respond,
          respondError: responder.respondError,
          requestId: responder.id,
        });
      }
    });

    // Handle channel registration (Step 7)
    connection.on('channels-register', async (
      params: ChannelsRegisterParams,
      responder?: { respond: (result: unknown) => void },
    ) => {
      await this.channelRegistry?.handleRegister(connection.id, params, responder as never);
    });

    // Handle channel changes (Step 7) — §14.5 dual-mode: the responder is
    // present for the Request form and carries itemized added-descriptor
    // results; absent for Notifications, where rejection is itemwise
    // filtering plus a diagnostic trace.
    connection.on('channels-changed', async (
      params: ChannelsChangedParams,
      responder?: { respond: (result: unknown) => void },
    ) => {
      await this.channelRegistry?.handleChanged(connection.id, params, responder as never);
    });

    // §6.6/§12: requests that previously had no handler and hung forever
    // (AUDIT-001 item 4). The connection-level grant gate has already run.
    // §17.3: a manifest-change announcement. Rate-limited re-fetch → diff
    // → §6.7 consequences → one receipt. The announcement itself carries no
    // payload and no authority; everything below acts on FETCHED content.
    connection.on('manifest-changed', (params: { revision?: string; domains?: string[] }) => {
      void this.handleManifestChanged(connection, params).catch((err) => {
        console.error(`[mcpl] ${connection.id} manifest refresh failed:`, err instanceof Error ? err.message : err);
      });
    });

    connection.on('channels-list', (
      _params: unknown,
      responder?: { respond: (result: unknown) => void },
    ) => {
      responder?.respond({
        channels: this.channelRegistry?.descriptorsForServer(connection.id) ?? [],
      });
    });

    connection.on('model-info', (
      _params: unknown,
      responder?: { respond: (result: unknown) => void; respondError?: (code: number, message: string, data?: unknown) => void },
    ) => {
      // §12.2 requires ALL FOUR of {id, vendor, contextWindow, capabilities}
      // in the DIRECT result shape, and numeric contextWindow cannot express
      // "unknown". The host has no truthful source for it, so modelInfo is
      // not advertised and this answers an explicit error instead of a
      // malformed partial (§6.6: a method that will never be answered
      // truthfully MUST error, not fabricate).
      responder?.respondError?.(
        -32601,
        'model/info unavailable: host does not advertise modelInfo (no truthful contextWindow source)',
      );
    });

    // Handle incoming channel messages (Step 7)
    connection.on('channels-incoming', async (
      params: ChannelsIncomingParams,
      responder?: { respond: (result: unknown) => void },
    ) => {
      const barrier = this.discordAwarenessBarrier;
      if (barrier) await barrier.promise;
      this.channelRegistry?.handleIncoming(connection.id, params, responder as never);
    });

    // Handle host-level admin commands from a surface (e.g. Discord /undo)
    connection.on('host-command', async (
      params: HostCommandParams,
      responder?: { respond: (result: unknown) => void; respondError: (code: number, message: string) => void },
    ) => {
      if (!responder) return;
      try {
        const barrier = this.discordAwarenessBarrier;
        if (barrier) await barrier.promise;
        const result = await this.handleHostCommand(connection.id, params ?? {});
        responder.respond(result);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        responder.respondError(-32603, err.message);
      }
    });

    // Handle dynamic tool list changes (notifications/tools/list_changed)
    connection.on('tools-list-changed', () => {
      // Pause before starting any async refresh. This listener runs
      // synchronously in the transport line callback, so a following inbound
      // data event cannot pass before the new barrier exists.
      const awarenessBarrier = this.installMcplDataPlaneGate();
      this.releaseMcplDataPlaneGate(awarenessBarrier);
      this.handleToolsListChanged(connection.id);
      void awarenessBarrier.promise.then(() => {
        this.completeMcplDataPlaneGate(awarenessBarrier);
      }).catch((error) => this.failMcplDataPlaneGate(
        awarenessBarrier,
        'tools-list reconciliation',
        error,
      ));
    });

    // Re-establish full server registration on reconnect. The 'close' handler
    // removed the feature-set state, so pushes / inference requests from the
    // revived server would otherwise be rejected with "Unknown server" until a
    // host restart. Re-runs the same init as the initial connect path (the
    // fresh handshake refreshed connection.capabilities); checkpoint trees
    // preserved across the transient close are resumed by idempotent
    // registration. Then refresh tools (server may have different tools).
    connection.on('reconnect', (info?: { attempts?: number }) => {
      // Install the barrier synchronously so any inbound event emitted after
      // reconnect observes it before doing work that could wake an agent. The
      // connection paused its data plane before wiring the fresh transport.
      const awarenessBarrier = this.installMcplDataPlaneGate();
      // Async: the §5.3 policy Request must be answered (re-establishing the
      // grant) before the data-plane barrier releases — otherwise the first
      // post-reconnect events land while the grant is still empty and are
      // rejected fail-closed instead of delivered.
      void (async () => {
        try {
          const config = this.mcplServerConfigs.get(connection.id);
          if (config) {
            await this.registerMcplServerFeatures(config, connection);
          }
        } catch (error) {
          console.error(
            `MCPL server "${connection.id}" re-registration after reconnect failed:`,
            error instanceof Error ? error.message : error,
          );
        }
        this.releaseMcplDataPlaneGate(awarenessBarrier);
        this.handleToolsListChanged(connection.id);
      })();
      void awarenessBarrier.promise.then(() => {
        if (
          awarenessBarrier.requiresBarrier
          && !this.completeMcplDataPlaneGate(awarenessBarrier)
        ) return;
        this.emitTrace({
          type: 'mcpl:server-reconnected',
          serverId: connection.id,
          attempts: info?.attempts ?? 0,
        });
        // Mirror the module:removed emitted on 'close' so module-lifecycle
        // consumers see the server come back, not just vanish.
        this.emitTrace({ type: 'module:added', moduleName: `mcpl:${connection.id}` });
      }).catch((error) => this.failMcplDataPlaneGate(
        awarenessBarrier,
        'reconnect reconciliation',
        error,
      ));
    });

    // Surface connect/reconnect failures. Before these traces existed the
    // only receipt was a console.error on the host's own stderr — invisible
    // unless someone ssh'd in and read the process log.
    connection.on('connect-failed', (params: { error: string; attempt: number }) => {
      this.emitTrace({
        type: 'mcpl:server-connect-failed',
        serverId: connection.id,
        error: params.error,
        attempt: params.attempt,
        willRetry: connection.willReconnect,
      });
    });
    connection.on('reconnect-failed', (params: { error: string; attempt: number }) => {
      this.emitTrace({
        type: 'mcpl:server-connect-failed',
        serverId: connection.id,
        error: params.error,
        attempt: params.attempt,
        willRetry: connection.willReconnect,
      });
      // The reconnect loop never gives up (backoff caps at ~300s), so
      // "the server is effectively down" is an attempt-count judgment:
      // 5 failed attempts ≈ a few minutes of outage. Throttled per
      // (serverId, kind), so a long outage re-posts every ~15 min.
      if (params.attempt >= 5) {
        this.opsAlert(
          'mcpl-down',
          connection.id,
          `MCPL server unreachable (attempt ${params.attempt}): ${params.error}`,
        );
      }
    });

    // A late response to a tools/call that already timed out, carrying
    // stateful data the server advanced to. The host can't re-inject it (the
    // dispatch context is gone), but surfacing it makes the checkpoint-tree
    // divergence greppable instead of a silent drift into stale state.
    connection.on('orphaned-response', (info: {
      id: string | number;
      method?: string;
      hadState: boolean;
      hadCheckpoint: boolean;
    }) => {
      this.emitTrace({
        type: 'mcpl:orphaned-response',
        serverId: connection.id,
        responseId: info.id,
        method: info.method,
        hadState: info.hadState,
        hadCheckpoint: info.hadCheckpoint,
      });
    });

    // Connection-level errors (e.g. child process 'error' after spawn).
    // Attaching this listener also keeps an unhandled EventEmitter 'error'
    // from crashing the host process.
    connection.on('error', (err: Error) => {
      this.emitTrace({
        type: 'mcpl:server-error',
        serverId: connection.id,
        error: err.message,
      });
    });

    // Cleanup on disconnect. Feature-set state is always dropped (the server
    // can't be validated while down; reconnect re-registers it). Checkpoint
    // trees, however, are durable state: CheckpointManager.removeServer deletes
    // them AND persists the deletion to Chronicle. The close handler must
    // therefore NEVER destroy checkpoints — `willReconnect` is false on a clean
    // stop() too (reconnectEnabled is cleared before 'close' fires), so gating
    // on it would erase every checkpoint tree on an ordinary host restart while
    // a SIGKILL preserves them. Permanent removal is owned solely by
    // disconnectMcplServer, which deletes the trees explicitly.
    connection.on('close', (code?: number | null, signal?: string | null) => {
      this.featureSetManager?.removeServer(connection.id);
      this.emitTrace({
        type: 'mcpl:server-closed',
        serverId: connection.id,
        code: code ?? null,
        signal: signal ?? null,
        willReconnect: connection.willReconnect,
      });
      this.emitTrace({ type: 'module:removed', moduleName: `mcpl:${connection.id}` });
    });
  }

  /**
   * Discover tools from all connected MCPL servers and cache them.
   * Tools are namespaced as `{toolPrefix}--{toolName}` per server config.
   */
  private async refreshMcplTools(): Promise<void> {
    if (!this.mcplServerRegistry) return;

    const tools: import('./types/index.js').ToolDefinition[] = [];
    const toolFeatureSets = new Map<string, string>();

    for (const server of this.mcplServerRegistry.getAllServers()) {
      const config = this.mcplServerConfigs.get(server.id);
      const prefix = config?.toolPrefix ?? `mcpl--${server.id}`;
      try {
        const result = await server.sendToolsList();
        for (const tool of result.tools) {
          if (!isToolAllowed(tool.name, config)) continue;
          const namespacedName = `${prefix}--${tool.name}`;
          const attributedTool = tool as typeof tool & {
            featureSet?: unknown;
            _meta?: { featureSet?: unknown };
          };
          const featureSet = typeof attributedTool.featureSet === 'string'
            ? attributedTool.featureSet
            : typeof attributedTool._meta?.featureSet === 'string'
              ? attributedTool._meta.featureSet
              : undefined;
          // MCP tool schemas are generic JSON Schema; cast to membrane's ToolDefinition format
          const schema = tool.inputSchema as import('./types/index.js').ToolDefinition['inputSchema'];
          tools.push({
            name: namespacedName,
            description: tool.description ?? '',
            inputSchema: schema,
          });
          if (featureSet !== undefined) {
            toolFeatureSets.set(namespacedName, featureSet);
          }
        }
      } catch {
        // Server may not support tools/list — skip silently
      }
    }

    this.mcplTools = tools;
    this.mcplToolFeatureSets = toolFeatureSets;
  }

  /**
   * Handle a tools/list_changed notification with collapse logic.
   * At most 2 refresh cycles can be in-flight: one running and one pending.
   */
  private handleToolsListChanged(serverId: string): void {
    if (this.mcplToolRefreshInFlight) {
      this.mcplToolRefreshPending = true;
      return;
    }

    this.mcplToolRefreshInFlight = true;
    const oldToolNames = new Set(this.mcplTools.map(t => t.name));

    this.refreshMcplTools()
      .then(() => {
        this.emitMcplToolDiff(oldToolNames, serverId);
      })
      .catch((error) => {
        console.error('MCPL tool refresh error:', error);
      })
      .finally(() => {
        this.mcplToolRefreshInFlight = false;
        if (this.mcplToolRefreshPending) {
          this.mcplToolRefreshPending = false;
          this.handleToolsListChanged(serverId);
        }
      });
  }

  /**
   * Emit a trace event and push an external-message listing newly added tools.
   */
  private emitMcplToolDiff(oldToolNames: Set<string>, serverId: string): void {
    const newTools = this.mcplTools.filter(t => !oldToolNames.has(t.name));
    const removedTools = [...oldToolNames].filter(name => !this.mcplTools.some(t => t.name === name));

    if (newTools.length === 0 && removedTools.length === 0) return;

    this.emitTrace({
      type: 'module:added',
      moduleName: `mcpl:${serverId}:tools-refreshed`,
    });

    if (newTools.length > 0) {
      const toolList = newTools.map(t => t.name).join(', ');
      this.pushEvent({
        type: 'external-message',
        source: `mcpl:${serverId}`,
        content: `New tools available: ${toolList}`,
        metadata: { newTools: newTools.map(t => t.name), removedTools },
      });
    }
  }

  /**
   * Dispatch a tool call to an MCPL server.
   * Strips the configured toolPrefix and routes to the server.
   */
  private dispatchMcplToolCall(agentName: string, call: ToolCall, serverId: string, prefix: string): void {
    const toolName = call.name.slice(prefix.length + 2); // strip "{prefix}--"
    const server = this.mcplServerRegistry!.getServer(serverId);

    if (!server) {
      this.pushEvent({
        type: 'tool-result',
        callId: call.id,
        agentName,
        moduleName: `mcpl:${serverId}`,
        result: { success: false, error: `MCPL server not found: ${serverId}`, isError: true },
      });
      return;
    }

    const config = this.mcplServerConfigs.get(serverId);
    if (!isToolAllowed(toolName, config)) {
      this.emitTrace({ type: 'tool:failed', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, error: 'denied by tool policy' });
      this.pushEvent({
        type: 'tool-result',
        callId: call.id,
        agentName,
        moduleName: `mcpl:${serverId}`,
        result: {
          success: false,
          error: `Tool '${call.name}' is not permitted by this server's tool policy.`,
          isError: true,
        },
      });
      return;
    }

    this.emitTrace({ type: 'tool:started', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, input: call.input });
    const startTime = Date.now();
    const args = (call.input && typeof call.input === 'object') ? call.input as Record<string, unknown> : {};

    // Build state params for stateful tools (Step 8).
    // A tools/list attribution selects that exact stateful set. Untagged tools
    // retain the host-managed or unique server-managed fallback, but never guess
    // between multiple server-managed sets.
    let stateParams: { state?: unknown; checkpoint?: string } | undefined;
    let attributedFeatureSet: string | null = null;
    if (this.checkpointManager) {
      const toolFeatureSet = this.mcplToolFeatureSets.get(call.name);
      if (toolFeatureSet !== undefined) {
        if (
          this.checkpointManager.isHostManaged(serverId, toolFeatureSet)
          || this.checkpointManager.getStatefulFeatureSet(serverId, toolFeatureSet) !== null
        ) {
          attributedFeatureSet = toolFeatureSet;
        } else {
          console.warn(
            `[mcpl] Tool "${call.name}" declares unknown or non-stateful feature set ` +
            `"${toolFeatureSet}"; skipping state exchange.`,
          );
        }
      } else {
        attributedFeatureSet = this.checkpointManager.getHostManagedFeatureSet(serverId)
          ?? this.checkpointManager.getStatefulFeatureSet(serverId);
        if (
          attributedFeatureSet === null
          && this.checkpointManager.hasAmbiguousServerManagedFeatureSets(serverId)
        ) {
          console.warn(
            `[mcpl] Tool "${call.name}" has no feature-set attribution and server ` +
            `"${serverId}" has multiple server-managed stateful feature sets; ` +
            'skipping state exchange.',
          );
        }
      }

      if (attributedFeatureSet !== null) {
        if (this.checkpointManager.isHostManaged(serverId, attributedFeatureSet)) {
          stateParams = {
            state: this.checkpointManager.getCurrentState(serverId, attributedFeatureSet),
          };
        } else {
          const cp = this.checkpointManager.getCurrentCheckpoint(serverId, attributedFeatureSet);
          if (cp) stateParams = { checkpoint: cp };
        }
      }
    }

    server.sendToolsCall(toolName, args, stateParams)
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({ type: 'tool:completed', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, durationMs });

        // Record checkpoint from stateful tool response (Step 8).
        // Explicit response attribution is authoritative. Otherwise use the
        // tool-derived (or safe single-set) attribution chosen before the call.
        if (result.state && this.checkpointManager) {
          const fs = result.state.featureSet ?? attributedFeatureSet;
          if (fs && this.checkpointManager.isStateful(serverId, fs)) {
            this.checkpointManager.recordCheckpoint(serverId, fs, result.state);
          }
        }

        // INVARIANT: engaging a channel opens it. A successful explicit send
        // into a channel the registry knows as closed drives the same open
        // flow as channel_open (durable desired state, server subscribe), so
        // there is no such thing as posting into a channel that stays
        // half-alive (no typing, no reactions, no inbound forwarding).
        // Fire-and-forget: the send already succeeded; the open must not
        // delay or fail the tool result.
        if (
          this.channelRegistry &&
          SEND_ENGAGEMENT_TOOLS.has(toolName) &&
          result.isError !== true
        ) {
          const target =
            extractChannelIdFromToolResult(result.content) ??
            (typeof args.channelId === 'string' ? (args.channelId as string) : undefined);
          if (target) {
            this.channelRegistry
              .openIfClosedForSend(target, serverId)
              .then(({ status, channelId, label }) => {
                // Turn-scoped engagement record (mid-turn re-pin, 2026-07-31
                // n=7): a human follow-up in a channel the agent explicitly
                // sent into this turn counts as conversationally addressed.
                // Recorded here — not eagerly — because injection metadata
                // carries the CANONICAL channel id (descriptor form), while
                // send args often carry the raw provider id; this callback
                // has the resolved form. The already-open path resolves on
                // the microtask queue, i.e. before the tool-result event
                // that evaluates injections.
                if (status !== 'unknown-channel' && status !== 'ambiguous') {
                  let engaged = this.turnEngagedChannels.get(agentName);
                  if (!engaged) {
                    engaged = new Set();
                    this.turnEngagedChannels.set(agentName, engaged);
                  }
                  engaged.add(channelId ?? target);
                }
                if (status === 'opened') {
                  console.error(
                    `[channel] ${agentName}: explicit ${toolName} into closed channel ${target} — opened (send implies engagement)`,
                  );
                  this.recordChannelAutoOpenNotice(
                    agentName,
                    [{ channelId: channelId ?? target, label }],
                    'opened-by-reply',
                  );
                } else if (status === 'open-failed') {
                  console.error(
                    `[channel] ${agentName}: ${toolName} delivered to ${target} but the open-on-send failed — channel remains half-alive, will reconcile`,
                  );
                }
              })
              .catch((err) => console.error('[channel] open-on-send error:', err));
          }
        }

        // Convert MCP tool result to framework ToolResult.
        // When the result contains non-text blocks (e.g. images from an MCP
        // tool like zulip-mcp's fetch_attachment), pass the full content array
        // through so toMembraneToolResult can preserve image blocks natively.
        // Text-only results still collapse to a joined string for backward
        // compatibility with callers that expect data to be string-ish.
        const textContent = result.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');
        const hasNonText = result.content?.some((c) => c.type !== 'text');
        const data = result.isError
          ? undefined
          : hasNonText
            ? result.content
            : (textContent || undefined);

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: `mcpl:${serverId}`,
          result: {
            success: !result.isError,
            data,
            error: result.isError ? (textContent || 'Tool call failed') : undefined,
            isError: result.isError ?? false,
          },
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({ type: 'tool:failed', module: `mcpl:${serverId}`, tool: toolName, callId: call.id, error: err.message, stack: err.stack });

        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: `mcpl:${serverId}`,
          result: { success: false, error: err.message, isError: true },
        });
      });
  }

  /**
   * Build BeforeInferenceParams from agent state and trigger context.
   */
  /**
   * Dispatch a synthesized channel tool call.
   */
  private dispatchChannelToolCall(agentName: string, call: ToolCall): void {
    // Conversation forks act only on their home channel. channel_publish and
    // channel_close default a missing channelId to home and reject foreign
    // ones; channel_open is rejected outright — opening channels mutates
    // framework-global state (the open-channel set every agent's injections
    // are scoped against), which is not a fork's call to make.
    const home = this.conversationAgentHomes.get(agentName);
    if (home) {
      const reject = (error: string): void => {
        this.emitTrace({
          type: 'tool:failed', module: 'channels', tool: call.name, callId: call.id,
          error: `conversation agent ${agentName}: ${error}`,
        });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'channels',
          result: { success: false, error, isError: true },
        });
      };

      if (call.name === 'channel_open') {
        reject(`This conversation is bound to channel ${home}; conversation agents cannot open channels.`);
        return;
      }
      if (call.name === 'channel_publish' || call.name === 'channel_close') {
        const input = (call.input ?? {}) as { channelId?: string };
        if (!input.channelId) {
          call = { ...call, input: { ...input, channelId: home } };
        } else if (input.channelId !== home) {
          const verb = call.name === 'channel_publish' ? 'publishing to' : 'closing';
          reject(`This conversation is bound to channel ${home}; ${verb} ${input.channelId} is not allowed.`);
          return;
        }
      }
    }

    this.emitTrace({ type: 'tool:started', module: 'channels', tool: call.name, callId: call.id, input: call.input });
    const startTime = Date.now();

    this.channelRegistry!.handleChannelToolCall(call.name, call.input, { kind: 'agent', agentName })
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({ type: 'tool:completed', module: 'channels', tool: call.name, callId: call.id, durationMs });
        // A successful channel_open plants the agent's feet in the opened
        // channel. The agent's own deliberate open is the strongest "my next
        // words go here" signal in the system — stronger than any injection —
        // so it MOVES the current turn's prose pin (turnLocusPins), not just
        // the next turn's trigger state. (The original 2026-07-21 Aria fix
        // set only activeTriggerChannels, which resolveLocus reads at the
        // NEXT turn's freeze — the turn-frozen refactor had silently
        // regressed the "reply right after opening" case; found while
        // mapping the routing logic 2026-07-31, antra-ratified fix.) The
        // announcement rides THIS TOOL RESULT — model-requested content,
        // distance zero, the safest role there is — instead of a separate
        // window notice. lastAnnouncedLocus tracks it so announce-on-change
        // stays coherent. Locus-mode agents only: explicit mode has no pin.
        if (call.name === 'channel_open' && result?.success) {
          const opened =
            (result.data as { channelId?: string } | undefined)?.channelId
            ?? (call.input as { channelId?: string } | undefined)?.channelId;
          if (opened) {
            this.activeTriggerChannels.set(agentName, opened);
            const openerAgent = this.agents.get(agentName);
            if (openerAgent && (openerAgent.proseRouting === 'locus' || openerAgent.proseRouting === 'hybrid')) {
              this.turnLocusPins.set(agentName, opened);
              this.lastAnnouncedLocus.set(agentName, opened);
              result = {
                ...result,
                data: {
                  ...(result.data as Record<string, unknown> | undefined),
                  routing: 'Your plain speech now lands in this channel. Other channels need an explicit send tool.',
                },
              };
              console.error(
                `[routing] ${agentName}: channel_open -> pin moved to ${opened} (announced in tool result)`,
              );
            }
          }
        }
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'channels',
          result,
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({ type: 'tool:failed', module: 'channels', tool: call.name, callId: call.id, error: err.message });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'channels',
          result: { success: false, error: err.message, isError: true },
        });
      });
  }

  /**
   * Handle the synthesized `wake_add_rule` / `wake_remove_rule` tools: mutate
   * the hot-reloaded gate.json at runtime. Validation lives in the EventGate
   * (same path as gate.json load), so an invalid rule is surfaced as a tool
   * error and nothing is written.
   */
  private dispatchWakeRuleToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'gate', tool: call.name, callId: call.id, input: call.input });
    const finish = (result: ToolResult) => {
      this.emitTrace({
        type: result.isError ? 'tool:failed' : 'tool:completed',
        module: 'gate', tool: call.name, callId: call.id, durationMs: 0,
        ...(result.isError ? { error: result.error } : {}),
      });
      this.pushEvent({ type: 'tool-result', callId: call.id, agentName, moduleName: 'gate', result });
    };

    try {
      if (call.name === 'wake_remove_rule') {
        const input = (call.input ?? {}) as { name?: unknown };
        if (typeof input.name !== 'string' || !input.name) {
          finish({ success: false, error: 'wake_remove_rule: `name` (string) is required', isError: true });
          return;
        }
        const removed = this.removeGatePolicy(input.name);
        finish({
          success: true,
          data: { removed, name: input.name, policies: this.getGatePolicyNames() },
        });
        return;
      }

      // wake_add_rule — assemble the canonical behavior from the typed fields
      // (exactly one), then let the gate's own validator do the authoritative
      // range/shape checks.
      const input = (call.input ?? {}) as {
        name?: unknown; match?: unknown; resets?: unknown; position?: unknown;
        insertBefore?: unknown; insertAfter?: unknown; passthrough?: unknown;
        behavior?: unknown; debounceMs?: unknown; rateLimit?: unknown; passiveSample?: unknown;
      };
      const behaviorSources = [
        input.behavior !== undefined ? 'behavior' : null,
        input.debounceMs !== undefined ? 'debounceMs' : null,
        input.rateLimit !== undefined ? 'rateLimit' : null,
        input.passiveSample !== undefined ? 'passiveSample' : null,
      ].filter((s): s is string => s !== null);
      if (behaviorSources.length === 0) {
        finish({
          success: false,
          error: 'wake_add_rule: specify exactly one behavior — `behavior` ("always"/"defer"/"skip"), `debounceMs`, `rateLimit`, or `passiveSample`.',
          isError: true,
        });
        return;
      }
      if (behaviorSources.length > 1) {
        finish({
          success: false,
          error: `wake_add_rule: give only one behavior, got [${behaviorSources.join(', ')}].`,
          isError: true,
        });
        return;
      }
      const behavior: unknown =
        input.debounceMs !== undefined ? { debounce: input.debounceMs }
        : input.rateLimit !== undefined ? { rate_limit: input.rateLimit }
        : input.passiveSample !== undefined ? { passive_sample: input.passiveSample }
        : input.behavior;

      // Placement: at most one of position / insertBefore / insertAfter.
      // With none given, a replaced rule stays where it was and a new rule
      // appends (addPolicy's contract).
      const placementSources = [
        input.position !== undefined ? 'position' : null,
        input.insertBefore !== undefined ? 'insertBefore' : null,
        input.insertAfter !== undefined ? 'insertAfter' : null,
      ].filter((s): s is string => s !== null);
      if (placementSources.length > 1) {
        finish({
          success: false,
          error: `wake_add_rule: give at most one placement, got [${placementSources.join(', ')}].`,
          isError: true,
        });
        return;
      }
      let position: 'append' | 'prepend' | { before: string } | { after: string } | undefined;
      if (typeof input.insertBefore === 'string' && input.insertBefore) {
        position = { before: input.insertBefore };
      } else if (typeof input.insertAfter === 'string' && input.insertAfter) {
        position = { after: input.insertAfter };
      } else if (input.position === 'prepend' || input.position === 'append') {
        position = input.position;
      }

      const rawPolicy = {
        name: input.name,
        match: input.match ?? {},
        behavior,
        ...(input.passthrough !== undefined ? { passthrough: input.passthrough } : {}),
        ...(input.resets !== undefined ? { resets: input.resets } : {}),
      };

      // Before/after probe table + shadow lint: the moment a rule changes the
      // evaluation order is the moment its real semantics must be legible
      // (af#105 — a prepended catch-all sampler silently disabled the
      // addressed-message wakes for 12h before anyone could see why).
      const before = new Map(
        this.eventGate!.probeTable().map((r) => [r.probe, r]),
      );
      const policy = this.addGatePolicy(rawPolicy, position ? { position } : undefined);
      const after = this.eventGate!.probeTable();
      const probes = after.map((r) => {
        const prev = before.get(r.probe);
        const changed = !!prev && (prev.policy !== r.policy || prev.wouldWake !== r.wouldWake);
        return {
          probe: r.probe,
          rule: r.policy ?? '(default)',
          behavior: r.behavior,
          wouldWake: r.wouldWake,
          ...(changed ? { changed: true, was: `${prev!.policy ?? '(default)'} (wouldWake=${prev!.wouldWake})` } : {}),
        };
      });
      const shadowWarnings = this.eventGate!.lintShadows()
        .map((w) => formatShadowWarning(w));
      finish({
        success: true,
        data: {
          added: policy.name,
          policies: this.getGatePolicyNames(),
          ...(shadowWarnings.length > 0 ? { shadowWarnings } : {}),
          probes,
          ...(probes.some((p) => 'changed' in p)
            ? {}
            : { note: 'No canonical probe changed its winning rule — the new rule affects none of the common chat/heartbeat shapes, or only channel/path-specific events the probes do not model.' }),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ success: false, error: msg, isError: true });
    }
  }

  /**
   * Handle the synthesized `sleep` / `wake` tools. `sleep` arms the gate's
   * suppression window, optionally announces in the sticky channel, and ends
   * the turn (the agent goes idle immediately). `wake` clears sleep.
   */
  private dispatchSleepToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'gate', tool: call.name, callId: call.id, input: call.input });
    const gate = this.eventGate!;
    const input = (call.input ?? {}) as { seconds?: number; announce?: boolean; message?: string };

    const finish = (result: ToolResult) => {
      this.emitTrace({ type: 'tool:completed', module: 'gate', tool: call.name, callId: call.id, durationMs: 0 });
      this.pushEvent({ type: 'tool-result', callId: call.id, agentName, moduleName: 'gate', result });
    };

    if (call.name === 'wake') {
      const was = gate.clearSleep();
      finish({ success: true, data: { woke: was } });
      return;
    }

    const seconds = Number(input.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      finish({ success: false, error: 'sleep: `seconds` must be a positive number', isError: true });
      return;
    }

    const { until } = gate.setSleep(seconds, input.message, agentName);
    const announce = input.announce !== false; // default true
    const human =
      seconds >= 3600 ? `${(seconds / 3600).toFixed(1)}h`
      : seconds >= 60 ? `${Math.round(seconds / 60)}m`
      : `${Math.round(seconds)}s`;

    // Announce in the TURN's frozen locus (best-effort; never blocks the
    // result). The sleep tool runs mid-turn, so the pin is live — same
    // authority as every other speech path, no live re-resolution.
    if (announce && this.channelRegistry) {
      const text = input.message ?? `💤 Going quiet for ${human}. I'll still see messages, but won't respond until I wake.`;
      const agent = this.agents.get(agentName);
      if (agent?.proseRouting === 'disabled') {
        console.error(`[sleep] ${agentName}: proseRouting=disabled — sleep announcement not posted`);
      } else if (agent?.proseRouting === 'explicit') {
        // Explicit mode: announce to the turn's sticky prose target if the
        // model has set one; otherwise stay quiet — never guess a channel.
        const target = this.proseTargetPins.get(agentName);
        if (target) {
          this.channelRegistry.routeSpeech(agentName, text, target).catch((err) => {
            console.error('[sleep] announce failed:', err instanceof Error ? err.message : err);
          });
        } else {
          console.error(`[sleep] ${agentName}: no prose target this turn — sleep announcement not posted (explicit mode never guesses)`);
        }
      } else {
        const locus = this.turnLocusPins.get(agentName) ?? null;
        this.channelRegistry.routeSpeech(agentName, text, locus).catch((err) => {
          console.error('[sleep] announce failed:', err instanceof Error ? err.message : err);
        });
      }
    }

    console.error(`[sleep] agent=${agentName} seconds=${seconds} announce=${announce} until=${new Date(until).toISOString()}`);
    // endTurn: the agent stops here and goes idle for the duration.
    finish({
      success: true,
      data: {
        sleepingFor: human,
        until,
        untilLocal: formatZonedDateTime(until, this.timeZone),
        timeZone: this.timeZone,
      },
      endTurn: true,
    });
  }

  /**
   * Handle the synthesized `read_image` tool: read image bytes from a
   * workspace mount and return them as a native MCP-shaped content array
   * (`[{type:'text'…},{type:'image', data, mimeType}]`). The live-turn
   * converter (tryNativeToolResultContent → membrane tool_result image
   * blocks) delivers the actual image to the model; history storage keeps
   * the standard compact `[image: …]` placeholder.
   */
  private dispatchReadImageToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'workspace', tool: call.name, callId: call.id, input: call.input });
    const finish = (result: ToolResult): void => {
      this.emitTrace({
        type: result.isError ? 'tool:failed' : 'tool:completed',
        module: 'workspace',
        tool: call.name,
        callId: call.id,
        durationMs: 0,
        ...(result.isError ? { error: result.error } : {}),
      });
      this.pushEvent({ type: 'tool-result', callId: call.id, agentName, moduleName: 'workspace', result });
    };
    void (async (): Promise<void> => {
      try {
        const workspace = this.getWorkspaceModule();
        if (!workspace || typeof workspace.readBinary !== 'function') {
          throw new Error('read_image requires a workspace module');
        }
        const input = (call.input ?? {}) as { path?: unknown };
        if (typeof input.path !== 'string' || input.path.length === 0) {
          throw new Error('read_image: `path` (mount-prefixed) is required');
        }
        // Anthropic rejects images >5MB (and >8000px); guard the hard byte
        // limit here — resizing is out of scope without an image library.
        const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
        // Prefer the workspace module's own read_image handler when it exists:
        // it reads tree-first with a FILESYSTEM FALLBACK, so binaries that live
        // only on disk (shell-created files, pre-fix mangled tree blobs) still
        // render. The legacy tree-only path below stays for older workspace
        // modules that don't advertise the tool.
        if (
          typeof workspace.handleToolCall === 'function' &&
          typeof workspace.getTools === 'function' &&
          workspace.getTools().some((tool) => tool.name === 'read_image')
        ) {
          const result = await workspace.handleToolCall({ ...call, name: 'read_image' });
          if (result.success && Array.isArray(result.data)) {
            const image = result.data.find(
              (block): block is { type: 'image'; data: string; mimeType: string } =>
                typeof block === 'object' && block !== null &&
                (block as { type?: unknown }).type === 'image' &&
                typeof (block as { data?: unknown }).data === 'string',
            );
            const byteLength = image ? Math.floor((image.data.length * 3) / 4) : 0;
            if (byteLength > MAX_IMAGE_BYTES) {
              throw new Error(
                `read_image: "${input.path}" is ~${byteLength} bytes — ` +
                `over the ${MAX_IMAGE_BYTES}-byte model limit`,
              );
            }
          }
          finish(result);
          return;
        }
        const read = await workspace.readBinary(input.path);
        if ('error' in read) throw new Error(read.error);
        const mediaType = sniffImageMediaType(read.data);
        if (!mediaType) {
          throw new Error(
            `read_image: "${input.path}" does not look like a supported image ` +
            '(png/jpeg/gif/webp — checked by magic bytes, not extension)',
          );
        }
        if (read.data.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(
            `read_image: "${input.path}" is ${read.data.byteLength} bytes — ` +
            `over the ${MAX_IMAGE_BYTES}-byte model limit`,
          );
        }
        finish({
          success: true,
          data: [
            {
              type: 'text',
              text: `${input.path} (${mediaType}, ${Math.ceil(read.data.byteLength / 1024)} KB):`,
            },
            { type: 'image', data: read.data.toString('base64'), mimeType: mediaType },
          ],
        });
      } catch (error) {
        finish({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    })();
  }

  /**
   * Handle the synthesized `save_recent_image` tool: locate the requested
   * image blocks in the calling agent's context (blobs re-inlined, counted
   * back from the most recent) and write their bytes to a workspace mount
   * via WorkspaceModule.writeBinary.
   */
  private dispatchSaveImageToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'workspace', tool: call.name, callId: call.id, input: call.input });
    const finish = (result: ToolResult): void => {
      this.emitTrace({
        type: result.isError ? 'tool:failed' : 'tool:completed',
        module: 'workspace',
        tool: call.name,
        callId: call.id,
        durationMs: 0,
        ...(result.isError ? { error: result.error } : {}),
      });
      this.pushEvent({ type: 'tool-result', callId: call.id, agentName, moduleName: 'workspace', result });
    };
    void (async (): Promise<void> => {
      try {
        const workspace = this.getWorkspaceModule();
        if (!workspace) throw new Error('save_recent_image requires a workspace module');
        const agent = this.agents.get(agentName);
        if (!agent) throw new Error(`Unknown agent: ${agentName}`);
        const input = (call.input ?? {}) as { path?: unknown; index?: unknown; count?: unknown };
        if (typeof input.path !== 'string' || input.path.length === 0) {
          throw new Error('save_recent_image: `path` (mount-prefixed) is required');
        }
        const index = input.index === undefined ? 0 : Number(input.index);
        if (!Number.isInteger(index) || index < 0) {
          throw new Error('save_recent_image: `index` must be a non-negative integer');
        }
        const count = input.count === undefined ? 1 : Number(input.count);
        const MAX_COUNT = 20;
        if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
          throw new Error(`save_recent_image: \`count\` must be an integer in 1..${MAX_COUNT}`);
        }
        const lastWanted = index + count - 1;

        // Walk the message store tail-first in bounded windows, re-inlining
        // blob media, until we've collected the requested range. Scanning is
        // capped so a pathological index can't drag the whole store through
        // blob resolution.
        const MAX_SCAN = 500;
        const WINDOW = 25;
        const cm = agent.getContextManager();
        const total = cm.getMessageCount();
        let seen = 0;
        let scanned = 0;
        const found: Array<{
          rangeOffset: number;
          data: string;
          mediaType: string;
          messagesBack: number;
        }> = [];
        for (let end = total; end > 0 && scanned < MAX_SCAN && found.length < count; end -= WINDOW) {
          const start = Math.max(0, end - WINDOW);
          const { messages } = cm.getMessageWindow(start, end - start, { resolveBlobs: true });
          scanned += end - start;
          for (let i = messages.length - 1; i >= 0 && found.length < count; i--) {
            const content = messages[i]?.content;
            if (!Array.isArray(content)) continue;
            for (let b = content.length - 1; b >= 0 && found.length < count; b--) {
              const block = content[b] as {
                type?: string;
                source?: { type?: string; data?: string; mediaType?: string };
              };
              if (block?.type !== 'image') continue;
              if (seen >= index && seen <= lastWanted) {
                if (block.source?.type !== 'base64' || typeof block.source.data !== 'string') {
                  throw new Error(
                    `save_recent_image: image at index ${seen} is not stored inline (base64) — cannot save it`,
                  );
                }
                found.push({
                  rangeOffset: seen - index,
                  data: block.source.data,
                  mediaType: block.source.mediaType ?? 'image/png',
                  messagesBack: total - (start + i),
                });
              }
              seen++;
            }
          }
        }
        if (found.length === 0) {
          throw new Error(
            seen === 0
              ? `save_recent_image: no images found in the most recent ${Math.min(scanned, MAX_SCAN)} messages`
              : `save_recent_image: only ${seen} image(s) found in the most recent ${Math.min(scanned, MAX_SCAN)} messages (asked for index ${index})`,
          );
        }

        // Single image → path as given. Range → numeric suffix before the
        // extension ("cat.png" → "cat-0.png"), 0 = newest of the range.
        const pathFor = (rangeOffset: number): string => {
          if (count === 1) return input.path as string;
          const p = input.path as string;
          const dot = p.lastIndexOf('.');
          const slash = p.lastIndexOf('/');
          return dot > slash
            ? `${p.slice(0, dot)}-${rangeOffset}${p.slice(dot)}`
            : `${p}-${rangeOffset}`;
        };
        const savedFiles: Array<Record<string, unknown>> = [];
        for (const image of found) {
          const destination = pathFor(image.rangeOffset);
          const bytes = Buffer.from(image.data, 'base64');
          const result = await workspace.writeBinary(destination, bytes, image.mediaType);
          if (!result.success) {
            finish({
              success: false,
              error:
                `save_recent_image: failed writing "${destination}": ${result.error}` +
                (savedFiles.length > 0
                  ? ` (already saved: ${savedFiles.map((f) => f.path).join(', ')})`
                  : ''),
              isError: true,
            });
            return;
          }
          savedFiles.push({
            ...(result.data as Record<string, unknown>),
            imageIndex: index + image.rangeOffset,
            messagesBack: image.messagesBack,
          });
        }
        finish({
          success: true,
          data: {
            saved: savedFiles,
            ...(found.length < count
              ? { note: `only ${found.length} of ${count} requested images exist in the scanned window` }
              : {}),
          },
        });
      } catch (error) {
        finish({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    })();
  }

  /** The `utils` meta-tool: list/describe/run over module utilities
   *  (Module.getUtilities). Shared by the model-facing dispatcher and the
   *  programmatic path (executeToolCall), so code_execution scripts and
   *  ephemerals reach utilities too. */
  private async handleUtilsToolCall(agentName: string, call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as { action?: unknown; name?: unknown; args?: unknown };
    const utilities = this.moduleRegistry.getAllUtilities();
    const available = (): string =>
      utilities.length ? utilities.map((u) => u.name).join(', ') : '(none registered)';
    switch (input.action) {
      case 'list':
        return {
          success: true,
          data: utilities.map((u) => ({ name: u.name, description: utilityOneLiner(u.description) })),
        };
      case 'describe': {
        const def = utilities.find((u) => u.name === input.name);
        if (!def) {
          return { success: false, isError: true, error: `No utility "${String(input.name)}". Available: ${available()}` };
        }
        return { success: true, data: def };
      }
      case 'run': {
        const def = utilities.find((u) => u.name === input.name);
        if (!def) {
          return { success: false, isError: true, error: `No utility "${String(input.name)}". Available: ${available()}` };
        }
        const args = input.args ?? {};
        const problem = validateUtilityArgs(args, def.inputSchema);
        if (problem) {
          // Teach by bounce: the error carries the schema, so the retry needs
          // no describe round-trip.
          return {
            success: false,
            isError: true,
            error: `${problem}. Schema for ${def.name}: ${JSON.stringify(def.inputSchema)}`,
          };
        }
        // Same dispatch as a first-class tool call — the module cannot tell
        // which surface the call came through.
        return this.moduleRegistry.handleToolCall({
          id: call.id,
          name: def.name,
          input: args,
          callerAgentName: agentName,
        });
      }
      default:
        return { success: false, isError: true, error: 'action must be "list", "describe", or "run"' };
    }
  }

  private dispatchUtilsToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'framework', tool: 'utils', callId: call.id, input: call.input });
    const startedAt = Date.now();
    void this.handleUtilsToolCall(agentName, call)
      .catch((err): ToolResult => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      }))
      .then((result) => {
        if (result.success) {
          this.emitTrace({ type: 'tool:completed', module: 'framework', tool: 'utils', callId: call.id, durationMs: Date.now() - startedAt });
        } else {
          this.emitTrace({ type: 'tool:failed', module: 'framework', tool: 'utils', callId: call.id, error: result.error ?? 'unknown error' });
        }
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'framework',
          result,
        });
      });
  }

  private dispatchAgentSettingsToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({
      type: 'tool:started',
      module: 'agent',
      tool: call.name,
      callId: call.id,
      input: call.input,
    });
    let result: ToolResult;
    try {
      const input = (call.input ?? {}) as {
        action?: unknown;
        context_budget_tokens?: unknown;
        tail_tokens?: unknown;
        transition_pace_tokens?: unknown;
        same_round_think_text_policy?: unknown;
        immediate?: unknown;
        settings?: unknown;
      } & Record<string, unknown>;
      const extensions = this.collectAgentSettingsExtensions();
      /** Extension values merged flat alongside the core snapshot. */
      const extGet = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const ext of extensions.values()) Object.assign(out, ext.get(agentName));
        return out;
      };
      switch (input.action) {
        case 'get':
          result = {
            success: true,
            data: { ...this.getAgentRuntimeSettings(agentName), ...extGet() },
          };
          break;
        case 'cancel':
          result = { success: true, data: this.cancelAgentRuntimeSettingsTransition(agentName) };
          break;
        case 'update': {
          const patch: AgentRuntimeSettingsPatch = {};
          if (input.context_budget_tokens !== undefined) {
            patch.contextBudgetTokens = Number(input.context_budget_tokens);
          }
          if (input.tail_tokens !== undefined) patch.tailTokens = Number(input.tail_tokens);
          if (input.transition_pace_tokens !== undefined) {
            patch.transitionPaceTokens = Number(input.transition_pace_tokens);
          }
          if (input.same_round_think_text_policy !== undefined) {
            patch.sameRoundThinkTextPolicy = input.same_round_think_text_policy as AgentRuntimeSettingsPatch['sameRoundThinkTextPolicy'];
          }
          // Immediate budget decrease: skip the paced descent; the next
          // compile plans straight at the new budget (one-shot fold-down).
          if (input.immediate !== undefined) patch.immediate = Boolean(input.immediate);
          // Route extension-owned keys to their modules; apply the core patch
          // only when it touches core keys (an extension-only update must not
          // disturb a converging budget transition).
          const extResults: Record<string, unknown> = {};
          for (const ext of extensions.values()) {
            const slice: Record<string, unknown> = {};
            for (const key of ext.keys) {
              if (input[key] !== undefined) slice[key] = input[key];
            }
            if (Object.keys(slice).length > 0) {
              Object.assign(extResults, ext.update(agentName, slice));
            }
          }
          const coreTouched = Object.keys(patch).length > 0;
          const core = coreTouched
            ? this.updateAgentRuntimeSettings(agentName, patch)
            : this.getAgentRuntimeSettings(agentName);
          result = {
            success: true,
            data: {
              ...core,
              ...extGet(),
              ...extResults,
              ...(patch.sameRoundThinkTextPolicy !== undefined
                ? {
                    sameRoundThinkTextPolicyUpdateNote:
                      'Stored now; applies to provider think routing and description beginning with the next inference.',
                  }
                : {}),
            },
          };
          break;
        }
        case 'reset': {
          let keys: Array<keyof AgentRuntimeSettingsPatch> | undefined;
          const extResetKeys = new Map<AgentSettingsExtension, string[]>();
          const resetsAllSettings = input.settings === undefined;
          if (input.settings !== undefined) {
            if (!Array.isArray(input.settings)) throw new Error('reset `settings` must be an array');
            const names: Record<string, keyof AgentRuntimeSettingsPatch> = {
              context_budget_tokens: 'contextBudgetTokens',
              tail_tokens: 'tailTokens',
              transition_pace_tokens: 'transitionPaceTokens',
              same_round_think_text_policy: 'sameRoundThinkTextPolicy',
            };
            keys = [];
            for (const name of input.settings) {
              if (typeof name === 'string' && names[name]) {
                keys.push(names[name]);
                continue;
              }
              const owner = [...extensions.values()].find(
                (ext) => typeof name === 'string' && ext.keys.includes(name),
              );
              if (!owner) throw new Error(`Unknown reset setting: ${String(name)}`);
              const list = extResetKeys.get(owner) ?? [];
              list.push(name as string);
              extResetKeys.set(owner, list);
            }
            if (keys.length === 0) keys = undefined;
          }
          const touchedSameRoundThinkTextPolicy =
            resetsAllSettings || keys?.includes('sameRoundThinkTextPolicy') === true;
          const extResults: Record<string, unknown> = {};
          if (input.settings === undefined) {
            // Reset-all covers extensions too.
            for (const ext of extensions.values()) {
              if (ext.reset) Object.assign(extResults, ext.reset(agentName));
            }
          } else {
            for (const [ext, list] of extResetKeys) {
              if (ext.reset) Object.assign(extResults, ext.reset(agentName, list));
            }
          }
          const coreTouched = input.settings === undefined || keys !== undefined;
          const core = coreTouched
            ? this.resetAgentRuntimeSettings(agentName, keys)
            : this.getAgentRuntimeSettings(agentName);
          result = {
            success: true,
            data: {
              ...core,
              ...extGet(),
              ...extResults,
              ...(touchedSameRoundThinkTextPolicy
                ? {
                    sameRoundThinkTextPolicyUpdateNote:
                      'Reset now; restored provider think routing and description apply beginning with the next inference.',
                  }
                : {}),
            },
          };
          break;
        }
        default:
          throw new Error('agent_settings: action must be get, update, reset, or cancel');
      }
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
    this.emitTrace({
      type: result.isError ? 'tool:failed' : 'tool:completed',
      module: 'agent',
      tool: call.name,
      callId: call.id,
      durationMs: 0,
      ...(result.isError ? { error: result.error } : {}),
    });
    this.pushEvent({
      type: 'tool-result',
      callId: call.id,
      agentName,
      moduleName: 'agent',
      result,
    });
  }

  /** Aggregate the event-tag vocabulary: reserved chat:* core + each connected
   *  server's declared tag ontology + gate.js status. */
  private buildEventTagsResult(): Record<string, unknown> {
    const servers: Record<string, Record<string, unknown>> = {};
    for (const conn of this.mcplServerRegistry?.getAllServers() ?? []) {
      const declared = this.featureSetManager?.getDeclaredFeatureSets(conn.id) ?? {};
      const sets: Record<string, unknown> = {};
      for (const [name, decl] of Object.entries(declared)) {
        if (decl.tagOntology) sets[name] = decl.tagOntology;
      }
      if (Object.keys(sets).length > 0) servers[conn.id] = sets;
    }
    return {
      core: AgentFramework.CHAT_CORE_TAGS,
      servers,
      gateScript: this.eventGate?.getStatus().script ?? null,
      hint:
        'Use these in gate.json policies (match.tagsAny / tagsAll / tagsNone) or ' +
        'in gate.js. Unknown/undeclared tags are tolerated (open ontologies).',
    };
  }

  private dispatchEventTagsToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'gate', tool: call.name, callId: call.id, input: call.input });
    let result: import('./types/events.js').ToolResult;
    try {
      result = { success: true, data: this.buildEventTagsResult() };
      this.emitTrace({ type: 'tool:completed', module: 'gate', tool: call.name, callId: call.id, durationMs: 0 });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitTrace({ type: 'tool:failed', module: 'gate', tool: call.name, callId: call.id, error: err.message });
      result = { success: false, error: err.message, isError: true };
    }
    this.pushEvent({ type: 'tool-result', callId: call.id, agentName, moduleName: 'gate', result });
  }

  private dispatchGateToolCall(agentName: string, call: ToolCall): void {
    this.emitTrace({ type: 'tool:started', module: 'gate', tool: call.name, callId: call.id, input: call.input });
    const startTime = Date.now();

    this.eventGate!.handleToolCall()
      .then((result) => {
        const durationMs = Date.now() - startTime;
        this.emitTrace({ type: 'tool:completed', module: 'gate', tool: call.name, callId: call.id, durationMs });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'gate',
          result,
        });
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitTrace({ type: 'tool:failed', module: 'gate', tool: call.name, callId: call.id, error: err.message });
        this.pushEvent({
          type: 'tool-result',
          callId: call.id,
          agentName,
          moduleName: 'gate',
          result: { success: false, error: err.message, isError: true },
        });
      });
  }

  private buildBeforeInferenceParams(agent: Agent, trigger?: InferenceRequest): BeforeInferenceParams {
    const inferenceId = `${agent.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      inferenceId,
      // Conversation identity = the agent (a trunk agent IS its own conversation;
      // forks get their own agent). The turn's channel LOCUS — the "proper
      // conversation tracking" this once flagged as a TODO — is now tracked
      // per-agent in `activeTriggerChannels` and surfaced to the agent via
      // buildChannelContext (channels.defaultOutgoing) below, so the agent is
      // told the same channel its speech will route to (item-3 redux).
      conversationId: agent.name,
      turnIndex: 0, // Simplified; needs per-conversation counter TODO
      userMessage: null, // Could extract from trigger context
      // Truthful fields only (§10.1 honesty over completeness): id is real,
      // vendor/contextWindow/capabilities have no source in this host and
      // are omitted rather than fabricated — the hardcoded 200000 was false
      // for residents configured at 300k/600k.
      model: { id: agent.model },
      channels: this.channelRegistry?.buildChannelContext(agent.name),
    };
  }
}
