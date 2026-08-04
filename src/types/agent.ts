import type { ContentBlock, YieldingStream } from '@animalabs/membrane';
import type { ContextStrategy } from '@animalabs/context-manager';
import type { ToolCallId, ToolResult, ToolCall } from './events.js';

export type SameRoundThinkTextPolicy = 'public' | 'private';
export type SameRoundThinkTextPolicySource =
  | 'runtime_override'
  | 'recipe'
  | 'compatibility_default';

/**
 * Configuration for an agent.
 */
export interface AgentConfig {
  /** Unique name for this agent */
  name: string;

  /** Model to use (e.g., 'claude-sonnet-4-20250514') */
  model: string;

  /** System prompt */
  systemPrompt: string;

  /** Context management strategy */
  strategy?: ContextStrategy;

  /**
   * Which tools this agent can use.
   * - 'all': all available tools
   * - string[]: specific tool names (with module prefix)
   */
  allowedTools?: 'all' | string[];

  /**
   * Which modules can trigger inference for this agent.
   * - 'all': any module
   * - string[]: specific module names
   */
  triggerSources?: 'all' | string[];

  /** Maximum tokens for response */
  maxTokens?: number;

  /** Temperature for inference */
  temperature?: number;

  /** Max input tokens before framework breaks a yielding stream and
   *  restarts with recompiled (compressed) context. Default: 150000. */
  maxStreamTokens?: number;

  /** Per-agent context compile budget (input tokens). When unset, the
   *  ContextManager's built-in default (100k) applies. */
  contextBudgetTokens?: number;

  /**
   * Prompt-cache TTL forwarded to the provider (Anthropic `cache_control.ttl`).
   * '5m' or '1h'. Defaults to '1h'.
   *
   * Why you'd set '1h': for persistent agents whose conversational cadence is
   * slower than 5 minutes, the default TTL expires between turns and the full
   * context is re-WRITTEN to cache on nearly every call. Cache writes carry a
   * premium (1.25x base input for 5m, 2x for 1h) while reads cost 0.1x — so a
   * chatty-but-not-rapid agent pays the write premium over and over. With '1h'
   * the write happens once per idle-hour and subsequent turns hit cache reads;
   * in practice cache writes can dominate spend for slow-cadence agents.
   * Set '5m' explicitly for high-frequency loops with sub-5-minute cadence,
   * where the cheaper write premium wins.
   */
  cacheTtl?: '5m' | '1h';

  /**
   * Whether to emit prompt-cache markers (cache_control) on requests.
   * Default true (Anthropic API). Set false for transports that reject
   * cache_control — e.g. Bedrock legacy Claude models, which fail with
   * "your request did not allow prompt caching".
   */
  promptCaching?: boolean;

  /**
   * Prefill-formatter support: a synthetic user message appended after the
   * conversation (e.g. chapterx's `<cmd>cat untitled.txt</cmd>` CLI-sim
   * scaffold). Forwarded verbatim to membrane's prefill formatters; ignored
   * by native formatting. Part of reproducing a prefill-era bot's exact
   * prompting structure when migrating it into a resident.
   */
  prefillUserMessage?: string;

  /** Provider-specific request parameters (for example Responses reasoning
   * and server-side compaction settings). */
  providerParams?: Record<string, unknown>;
  /**
   * Same-round routing policy for ordinary text emitted beside `think`.
   * Omitted preserves the compatibility carry-forward: public.
   */
  sameRoundThinkTextPolicy?: SameRoundThinkTextPolicy;
  /**
   * Extended thinking config. When `enabled: true`, the agent runs with
   * Anthropic's native extended thinking; responses include `thinking` blocks
   * with cryptographic signatures, and the API enforces `temperature: 1`
   * (Membrane handles this). Omit or set `enabled: false` to disable.
   */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    /** 'enabled' (explicit budget, default) or 'adaptive' (model-managed) */
    type?: 'enabled' | 'adaptive';
    /**
     * How thinking content is returned: 'summarized' (readable summary) or
     * 'omitted' (empty thinking field, signature only). Fable 5 / Opus 4.7+
     * default to 'omitted' — set 'summarized' to receive thinking text.
     */
    display?: 'summarized' | 'omitted';
  };
  /**
   * How to handle a model content-policy refusal (`stop_reason: refusal`).
   * When `autoRewind` is on, a refused turn triggers an automatic rewind: the
   * framework redacts the triggering turn (the tool result or message that
   * tripped the classifier), injects a metadata-only marker in its place (which
   * carries none of the offending content, so it cannot itself re-trip), and
   * re-runs — up to `maxRewinds` times before giving up. This keeps the agent
   * on its own model (no fallback-model substitution) while self-healing around
   * a poison turn. Default: off (a refusal just surfaces a marker + reaction).
   */
  refusalHandling?: {
    /**
     * Same-model retries on a content-policy refusal, performed by MEMBRANE
     * at the provider seam (passed through as `refusalRetries`). Default 0.
     *
     * Near the classifier's threshold a refusal is probabilistic rather than a
     * property of the payload: identical bytes pass and refuse minutes apart
     * (mythos, 2026-07-27 replay reps). So the first response is to ask again
     * — no context surgery, no fallback model. Membrane replays the SAME
     * request immediately and cache-warm, so only the discarded output tokens
     * are real spend.
     *
     * Retrying in the framework instead was tried and removed: a requeue
     * recompiles, so the attempts are correlated rather than fresh draws, and
     * it cannot tell a streaming consumer to drop the abandoned attempt.
     * Membrane announces each retry with a `retrying` stream event, which
     * driveStream handles by discarding what was streamed.
     *
     * Retries are spent before the framework sees the refusal at all, so the
     * escalation order is: membrane retries -> autoRewind (if on) -> the
     * refusal reaction, which therefore means "the border is close" rather
     * than firing on every near-threshold flip.
     *
     * Native tool mode only — see the XML-mode warning in Membrane.
     */
    retries?: number;
    /** Auto-rewind the triggering turn on refusal and retry. Default false. */
    autoRewind?: boolean;
    /** Max consecutive rewinds before giving up a turn. Default 3. */
    maxRewinds?: number;
    /**
     * When the rewound turn is a *human* message (not a machine tool result),
     * announce the withholding on the conversational surface (Discord) rather
     * than dropping it silently. Default true.
     */
    announceHumanTurns?: boolean;
  };

  /**
   * How the agent's PLAIN PROSE (non-tool output) reaches channels.
   * - 'locus' (default): host-inferred — the turn-frozen locus machinery.
   * - 'explicit': the model prefixes prose with a destination
   *   (`>>#channel` / `>>@person` / `>>skip_reply`); unprefixed prose is never
   *   delivered — it bounces to a clipboard for a cheap prefixed resend.
   *   See docs/explicit-prose-routing.md.
   */
  proseRouting?: 'locus' | 'explicit';
}

/** The intentionally small set of agent settings that may change in-process. */
export interface AgentRuntimeSettingsPatch {
  contextBudgetTokens?: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  sameRoundThinkTextPolicy?: SameRoundThinkTextPolicy;
  /**
   * Apply a `contextBudgetTokens` DECREASE immediately instead of starting a
   * paced descent: the next compile plans straight at the new budget and the
   * whole fold-down (and its KV invalidation) is paid on that one turn. Also
   * cancels any in-flight descent. No effect on increases (already immediate)
   * or on other keys. A MODE for this apply, not a setting — never persisted.
   *
   * This is the emergency lever: when window content must shrink NOW
   * (refusal streaks, over-wall wedges), a converging descent is the wrong
   * tool and used to be the only one (mythos, 2026-07-26).
   */
  immediate?: boolean;
}

export interface AgentRuntimeSettingsSnapshot {
  contextBudgetTokens: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  sameRoundThinkTextPolicy: SameRoundThinkTextPolicy;
  sameRoundThinkTextPolicySource: SameRoundThinkTextPolicySource;
  transition: 'stable' | 'converging' | 'blocked';
  transitionReason?: 'transition_pace_too_small' | 'protected_context_exceeds_target';
}

/** Persisted values differ from recipe defaults; omitted keys inherit config. */
export type AgentRuntimeSettingsOverrides = AgentRuntimeSettingsPatch;

/**
 * Result of running inference.
 */
export interface InferenceResult {
  /** Tool calls to execute */
  toolCalls: ToolCall[];
  /** Speech content (text blocks) to send to handlers */
  speechContent: ContentBlock[];
  /** Raw request/response for logging */
  raw?: {
    request: unknown;
    response: unknown;
  };
  /** Usage stats */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Stop reason */
  stopReason?: string;
  /** Whether inference was aborted */
  aborted?: boolean;
  /** Reason for abort, if available */
  abortReason?: string;
}

/**
 * Options for running inference.
 */
export interface InferenceOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Internal state of an agent.
 */
export type AgentState =
  | { status: 'idle' }
  | { status: 'inferring'; promise: Promise<InferenceResult>; abortController: AbortController }
  | { status: 'streaming'; stream: YieldingStream }
  | { status: 'waiting_for_tools'; pending: Map<ToolCallId, PendingToolCall>; completed: CompletedToolCall[]; stream?: YieldingStream }
  | { status: 'ready'; toolResults: CompletedToolCall[]; stream?: YieldingStream };

/**
 * A tool call that's in progress.
 */
export interface PendingToolCall {
  id: ToolCallId;
  name: string;
  input: unknown;
  startedAt: number;
}

/**
 * A tool call that has completed.
 */
export interface CompletedToolCall {
  id: ToolCallId;
  name: string;
  input: unknown;
  result: ToolResult;
  durationMs: number;
}

/**
 * Inference request for an agent.
 */
export interface InferenceRequest {
  agentName: string;
  reason: string;
  source: string;
  timestamp: number;
  /**
   * The MCPL channel whose message triggered this inference, if any (composite
   * id, e.g. `discord:guild:channel` / `discord:dm:id`). The framework routes
   * the turn's auto-published plain-text speech here so a single TRUNK agent
   * replies in the channel it is answering — not the process-global most-recent-
   * inbound locus, which a concurrent message elsewhere can hijack (item-3
   * redux). Undefined for non-channel wakes (heartbeat, timers, module events),
   * which correctly fall back to the global default channel.
   */
  channelId?: string;
  /**
   * True when the triggering message explicitly addressed the agent (mention,
   * reply-to-bot, DM — `chat:addressed` in MCPL RFC-001 terms). When a wake
   * batch spans several channels, an addressed channel outranks ambient
   * chatter for the turn's frozen speech locus: overheard conversation must
   * not capture the agent's voice just by being newest.
   */
  addressed?: boolean;
}
