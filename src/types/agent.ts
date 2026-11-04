import type { ContentBlock, YieldingStream } from '@animalabs/membrane';
import type { ContextStrategy } from '@animalabs/context-manager';
import type { ToolCallId, ToolResult, ToolCall } from './events.js';
import type { SilentHeartbeatTick } from '../silent-heartbeat.js';
import type { WakeLine } from '../gate/types.js';

export type SameRoundThinkTextPolicy = 'public' | 'private';
export type SameRoundThinkTextPolicySource =
  | 'runtime_override'
  | 'recipe'
  | 'compatibility_default';

/** What a continuation's `[continue]` row says (InferenceRequest.autoContinueRun). */
export interface AutoContinueRun {
  /** How the agent stops, as the row puts it ("call skip_reply"). */
  stop: string;
  /** The turn before ended in words some or all of which were held, not
   *  sent, because a send in it may already have posted where they were
   *  going. */
  heldAfterSend?: boolean;
  /** Set by the scheduler: the continuation is the turn's only cause. */
  sole?: boolean;
}

/** `AgentConfig.autoContinue` as an object (`true` means `{}`). */
export interface AutoContinueConfig {
  /** Continuations in a row before the agent waits for the next event:
   *  a whole number, 1 to 20. Default 3. */
  maxConsecutive?: number;
}

/**
 * Configuration for an agent.
 */
export interface AgentConfig {
  toolPresentation?: import("../tool-presentation.js").ToolPresentationConfig;
  /**
   * Unique name for this agent: create() refuses two configured agents of one
   * name. Names compare exactly, so `Dup` beside `dup` is two agents, though
   * the history tool's author filter matches their own turns without letter
   * case and can't tell them apart there.
   */
  name: string;

  /** Model to use (e.g., 'claude-sonnet-4-20250514') */
  model: string;

  /** System prompt */
  systemPrompt: string;

  /** Context management strategy */
  strategy?: ContextStrategy;

  /**
   * Enforced at dispatch for registered agent callers; omitted means 'all'.
   * - 'all': all available tools
   * - string[]: exact tool names, including module--utility names for utilities.
   * Utilities and the host's other rarely-used tools are in the host's
   * built-in toolset ("settings"), out of the tool list: the model reaches
   * them with toolsets--open {toolset:"settings"} and toolsets--act, each
   * checked under the tool's own name. An agent that should use a utility
   * from its model lists 'toolsets--open', 'toolsets--act' and
   * 'module--utility' (an agent without the two meta-tools keeps every other
   * tool in its list, but no utility). The name alone passes the dispatch
   * check for any call by that name, whether the host makes it with
   * executeToolCall on the agent's behalf or the model or a script makes it.
   * Trusted module calls are exempt. Genuinely unidentified public callers,
   * including unknown legacy names, remain unrestricted. Framework-created
   * identities have tool authority only while registered.
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
   *  restarts with recompiled (compressed) context. Default: 150000. Not
   *  checked mid-turn for an agent whose model binds its thinking
   *  (`thinkingBinding.binds`) with `physicalWindowTokens` set: a new stream
   *  there would take the turn's own earlier reasoning out of the request, and
   *  the window projection still guards the provider's hard cap. */
  maxStreamTokens?: number;

  /**
   * The model's PHYSICAL context window (provider hard cap, e.g. 200000).
   * When set, the framework projects each continuation round's real size
   * (cache-inclusive input of the latest call that reported its prompt +
   * that call's output + what the stream has grown by since, if later calls
   * reported none + the blocks about to be appended + reserve for response)
   * and restarts the stream through a fresh compile instead of dispatching a
   * request the provider will 400 (issue #92: a legal compile can walk past
   * the physical window mid-turn). The projection runs once a call on the
   * stream has reported its prompt. Unset → no projection; only the
   * maxStreamTokens restart applies. A value is converted to a number as a
   * comparison converts it, so a string such as "200000" reads as its number;
   * one whose number isn't finite, such as null, reads as unset.
   */
  physicalWindowTokens?: number;

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
   * A synthetic user message for a request whose formatted conversation
   * would otherwise begin with the assistant (e.g. chapterx's
   * `<cmd>cat untitled.txt</cmd>` CLI-sim scaffold). A non-empty value is
   * forwarded verbatim to membrane, on framework turns and the direct API
   * alike. Membrane's anthropic-xml formatter makes it the first message,
   * ahead of the assistant turn that carries the conversation. Its native
   * formatter uses it as the text of a leading user turn that its tool-pair
   * normalizer adds, in place of `[continuing]`. Part of reproducing a
   * prefill-era bot's exact prompting structure when migrating it into a
   * resident.
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
   * (Membrane handles this). Omit or set `enabled: false` to disable, except
   * on a model whose thinking is always on (Fable, Mythos), which thinks
   * whatever this says.
   */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    /** 'enabled' (explicit budget, default) or 'adaptive' (model-managed) */
    type?: 'enabled' | 'adaptive';
    /**
     * How thinking content is returned: 'summarized' (readable summary) or
     * 'omitted' (empty thinking field, signature only). Fable 5 / Opus 4.7+
     * default to 'omitted' — set 'summarized' to receive thinking text. A
     * model whose thinking is always on (Fable, Mythos) is sent a thinking
     * config only to carry `thinkingBinding.dropBlock`, so this reaches it
     * only with that set.
     */
    display?: 'summarized' | 'omitted';
  };
  /**
   * How the provider binds this agent's signed thinking to the conversation
   * before it. A host sets it from what it knows of the agent's model and
   * route.
   */
  thinkingBinding?: {
    /**
     * Ask the provider to drop a signed thinking block whose earlier
     * conversation has changed, as a fold changes it, rather than refuse the
     * request. An account that enforces the binding otherwise answers such a
     * request with a 400. One that doesn't decides for itself: the four
     * accounts tried on 2026-10-18 dropped such blocks silently, so there the
     * model sees nothing different and the report is what's new, and one
     * that would show such a block to the model is asked to drop it instead.
     *
     * It's sent as `thinking.block_binding.prefix_mismatch_behavior:
     * "drop_block"` with the `thinking-binding-controls-2026-08-01` beta,
     * which membrane's Anthropic and Bedrock adapters carry (Bedrock's
     * acceptance of the beta hasn't been tried). On any other adapter it does
     * nothing, so a host should refuse it there. A thinking config the host
     * sends itself, through `request.extra` or as `thinking` in
     * `providerParams`, replaces the one membrane builds, control included.
     *
     * On a model whose thinking is always on (Fable, Mythos), membrane
     * carries it in an adaptive thinking config whatever `thinking.enabled`
     * says, with `thinking.display` when that's set, so such an agent's
     * `display` takes effect only with this setting. On any other model, it
     * goes only in the thinking config membrane sends while thinking is on.
     * Membrane tells the first kind by its id, which names `fable` or
     * `mythos`. Opus 5.5, Haiku 5.5, Sonnet 5.5, Sonnet 5, Fable 5 and Fable
     * 5.1 accepted the config on 2026-10-18. Mythos hasn't been tried, and
     * membrane notes that the family has refused thinking configs with a 400
     * before, so for a Mythos model the setting may fail every request.
     *
     * On a framework turn, each call's report of the blocks the provider
     * dropped goes to its `inference:usage` trace, and neither that call nor
     * its stream's later calls feed the context strategy's calibration, since
     * the provider doesn't bill a block it dropped and the strategy still
     * counts it. After a fold, each block after the stretch it rewrote is
     * bound to a conversation the request no longer holds. Where the context
     * strategy still sends such a block, the provider drops it on every call
     * until a later fold takes it out of the context, and while such blocks
     * are sent, no stream gives a sample and the calibration keeps the value
     * it had. A strategy that leaves that thinking out at the fold sends none
     * to drop. The direct API carries the control too, but reads no report: it
     * traces no usage and feeds no calibration.
     *
     * Default false: nothing is sent, and the account's default applies.
     */
    dropBlock?: boolean;
    /**
     * Whether this agent's model binds its signed thinking to the
     * conversation before it, as the host knows from its own model records.
     * A context manager that keeps a record of what each branch sent can
     * then leave out thinking whose earlier conversation changed before the
     * provider sees it. Set:
     * - each compile the agent sends tells the context manager so
     *   (`thinkingBinding`: `binds`, `dropBlock` as set here, and the agent's
     *   name as the `participant` whose replies are its own), with digests
     *   of what the request carries ahead of its messages (`identity`: the
     *   system text with its system-position injections, the tools in the
     *   order sent, the model, and the thinking config, `maxTokens`,
     *   `providerParams` and `prefillUserMessage`);
     * - each framework stream tells the context manager which stored rows
     *   its later rounds and its last reply carried as stored
     *   (`noteRequestSent`), naming the compile it was built from, so their
     *   thinking is kept at the next compile. The direct API
     *   (`runInference`) notes nothing, so each of its replies' thinking is
     *   left out at the compile after it's stored;
     * - with `physicalWindowTokens` set too, `maxStreamTokens` no longer
     *   starts a new stream mid-turn, since the new stream's compile can take
     *   the turn's earlier reasoning out of the request;
     * - with `dropBlock` set too, where a compile reports where the branch's
     *   record began (`thinkingRecordedAfter`), a block the provider drops
     *   that the record doesn't account for raises the
     *   `thinking-binding-loss` ops alert, once per incident and again if a
     *   call drops more. The provider reports drops only on a request that
     *   carries the drop control; without it, such a block is refused;
     * - the agent is told nothing of reasoning left out or dropped: no line
     *   about the mechanics of its own memory or reasoning is put in its
     *   context. Hosts can observe compiles' strips through
     *   `Agent.onThinkingStrip`;
     * The record and the notes
     * vouch for requests as agent-framework hands them to membrane, so a
     * membrane `beforeRequest` hook that changes a request must change every
     * request alike. Default false: compiles and streams are as they were.
     */
    binds?: boolean;
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
  };

  /** Opt-in tool-output admission and one guarded retry after a provider
   * refusal. Agents can persistently override this via agent_settings
   * tool_result_guard. Full originals remain in Chronicle's audit history.
   * Default false. Disabling does not restore previously withheld output. */
  toolResultGuard?: boolean;

  /**
   * How the agent's PLAIN PROSE (non-tool output) reaches channels.
   * - 'locus' (default): host-inferred — the turn-frozen locus machinery.
   * - 'explicit': the model prefixes prose with a destination
   *   (`>>#channel` / `>>@person` / `>>skip_reply`); unprefixed prose is never
   *   delivered — it bounces to a clipboard for a cheap prefixed resend.
   *   See docs/explicit-prose-routing.md.
   * - 'hybrid': unprefixed prose keeps locus routing; `>>>destination` routes
   *   that publication envelope through the same authorized resolver.
   *   See docs/hybrid-prose-routing.md.
   * - 'disabled': generated prose is never published. Only explicit tools may
   *   send externally; prose remains in Chronicle, and a turn that wrote plain
   *   speech ends with a private `[delivered] plain speech → no channel` receipt.
   */
  proseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled';

  /**
   * Stored participants that are this agent's own voice, in addition to its
   * name: their turns are presented to the model as this agent's assistant
   * turns. A derived agent sets this to the agent it inherited from, so the
   * parent's turns read as its own history. Model-facing role assignment
   * only, applied at request assembly — stored authorship is never rewritten.
   */
  selfParticipants?: string[];

  /**
   * The participant name this agent's own turns are presented under at
   * request assembly. Defaults to `name`. A derived agent that should share
   * its parent's provider prefix sets the parent's name, so the two
   * requests are identical in formatters that render participant names as
   * well as in those that only assign roles. New turns are still STORED
   * under the agent's own name.
   */
  presentAs?: string;

  /**
   * Tools refused when this agent calls them, although they stay advertised.
   * Restricts a derived agent without changing the tool block at the front
   * of its request — removing a tool from `allowedTools` instead would
   * change those bytes and forfeit the provider prefix it shares with its
   * parent.
   */
  denyToolsAtDispatch?: string[];

  /**
   * Fail-closed containment for a text response whose entire visible prose is
   * an invocation-shaped wrapper naming a tool registered on that exact turn.
   * The wrapper is neither executed nor stored as assistant continuity; a
   * content-free system receipt is stored instead. Default false.
   */
  toolWrapperProseGuard?: boolean;

  /**
   * Continue on the agent's own turn ending (off when left out): a turn the
   * model ends itself (stop reason `end_turn` or `stop_sequence`), whether
   * its last response is prose or empty, is followed by another turn,
   * instead of a pause until the next event. A turn ended through
   * `skip_reply` (or another tool that ends the turn, such as `sleep`), or
   * whose last prose envelope is `>>skip_reply` (explicit) or `>>>skip_reply`
   * (hybrid), pauses as usual. So does one whose closing prose bounced (the
   * bounce and its cap answer it), and an agent offered no way to stop
   * (locus or disabled mode without an offered `skip_reply`).
   *
   * As the next turn starts, a short `[continue]` system row naming the agent
   * joins the window: another turn starts, how to stop, and that unmarked
   * words are sent as usual; on the last continuation of a run, that the
   * agent waits for the next event after it. It's written only when the
   * continuation is that turn's whole cause: a message batched with it makes
   * it that message's turn, with no row, in the message's channel. Otherwise
   * the next turn keeps the turn's locus (locus and hybrid modes). At most
   * `maxConsecutive` (default 3) continuations run in a row: the count
   * starts again when a turn starts with a cause of its own (a message, a
   * timer, a heartbeat that isn't a silent tick) or a tool ends one. Silent
   * heartbeat ticks, refusals, `max_tokens` cut-offs, the stall guard's
   * ends, ephemeral runs, conversation forks and a quiesce never continue. A
   * ` !` continuation the turn asked for runs instead, and counts toward
   * nothing. See docs/auto-continue.md.
   */
  autoContinue?: boolean | AutoContinueConfig;

  /**
   * Clock rows (off when left out): when a boundary of this interval on the
   * agent's local wall clock (counted from local midnight, in the
   * framework's `timeZone`) has passed since the last clock row, the window
   * takes one more — `Clock: 10:50 Europe/Berlin (UTC+02:00)`, with the date
   * when the day has changed — before the next thing it takes: an incoming
   * event, a turn's start, or, mid-turn, after a tool round's results, where
   * it also joins the live stream. Only the latest boundary is written, and
   * a window that holds no clock row yet takes one at the next of these. A
   * clock reads the boundary's time where its tick would have stood, else
   * the time it is written (after a tool's results, say), so it never
   * reads earlier than a row before it. A clock wakes no one. See
   * src/clock-rows.ts.
   *
   * - A stream that can't carry injected messages (membrane's XML prefill
   *   path) takes no mid-turn clock: the next event or turn start writes it.
   * - On some models a clock after a tool's results drops the loop's
   *   earlier thinking from the request, as any message heard while acting
   *   does there: at most once an interval.
   * - Residents share one window, so every resident reads the clock rows any
   *   of them writes, a resident with no `clock` of its own included. Each
   *   writes one when a boundary of its own interval has passed since the
   *   window's last clock, whichever resident wrote that. The subconscious
   *   takes none of its own: it reads the residents' through its merged
   *   view.
   */
  clock?: import('../clock-rows.js').ClockConfig;
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
  /**
   * The budget the agent is set to: while a lower one converges, its target,
   * and while a persisted one the agent couldn't apply is kept, that one.
   */
  contextBudgetTokens: number;
  /**
   * The budget compiles plan at now: the live budget, or the default when the
   * recipe sets none (the context manager's own default is the same). It
   * equals `contextBudgetTokens` except while a lower budget converges, when
   * it is still the budget the descent started from (context-manager #162),
   * and while a budget the agent couldn't apply is kept, when it is the
   * budget the agent runs at instead.
   */
  effectiveContextBudgetTokens: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  sameRoundThinkTextPolicy: SameRoundThinkTextPolicy;
  sameRoundThinkTextPolicySource: SameRoundThinkTextPolicySource;
  transition: 'stable' | 'converging' | 'blocked';
  transitionReason?: 'transition_pace_too_small' | 'protected_context_exceeds_target';
}

/** Persisted values differ from recipe defaults; omitted keys inherit config. */
export type AgentRuntimeSettingsOverrides = AgentRuntimeSettingsPatch & {
  /**
   * The record's own `contextBudgetTokens`, written when a compile at the
   * agent's live budget fits at it, with nothing about the budget changed
   * while it ran (a paced descent's settle included): the store fit that
   * budget. A compile the context manager refuses at it as over budget
   * withdraws it, unless a compile at it that started later has already
   * ended.
   * When it equals `contextBudgetTokens`, a restore applies that budget at
   * once, rather than pacing a descent again from the recipe's budget
   * (context-manager #162), if a preview at boot says it still fits; if not,
   * a budget below the recipe's restores paced, and if a compile at one that
   * the boot applied at once is refused, the agent restores it paced then.
   * Since the store fit it when the field was written, the planner can fold
   * to it at once even if its carried frontier was lost. Any other value is
   * stale (the budget changed since, or an earlier release carried the field
   * forward), and a budget below the recipe's restores paced, as it does
   * without the field. Never part of a patch.
   */
  contextBudgetReachedTokens?: number;
};

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
 *
 * `supportsInjectedMessages` is what the stream declared with the round's
 * tool calls (membrane's `ToolContext.supportsInjectedMessages`): whether it
 * can carry messages injected with that round's results. It's absent when
 * the stream doesn't say, which reads as a stream that can't, and when there
 * is no stream, as for the direct API.
 */
export type AgentState =
  | { status: 'idle' }
  | { status: 'inferring'; promise: Promise<InferenceResult>; abortController: AbortController }
  | { status: 'streaming'; stream: YieldingStream }
  | { status: 'waiting_for_tools'; pending: Map<ToolCallId, PendingToolCall>; completed: CompletedToolCall[]; stream?: YieldingStream; supportsInjectedMessages?: boolean }
  | { status: 'ready'; toolResults: CompletedToolCall[]; stream?: YieldingStream; supportsInjectedMessages?: boolean };

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
  /** Host-owned identity for withdrawal of an unconsumed coalesced wake. */
  coalescingSubject?: string;
  coalescingEventId?: string;
  /** Host-owned: this wake's cause is an RFC-006 deferred batch, which has
   *  no model-visible content until it renders at the turn's assembly. */
  coalescingBatch?: boolean;
  /** Host-owned, set on a turn's trigger when EVERY request batched into it
   *  was a deferred-batch wake: these are their subjects. If assembly settles
   *  all of them without materializing content, the turn has no cause left
   *  and does not run. */
  coalescingBatchSubjects?: string[];
  /** Host-owned: this wake's sole cause is this write, deferred for its
   *  agent while a turn was alive: a coalesced render placed in its queue
   *  (wakeToRead), or a message, notice or event whose wake was queued with
   *  it. Once a request that carried the write was answered and, for a wake
   *  that carries a channel and isn't marked `ambient`, the agent has since
   *  published into that channel having read it, or once the write is in
   *  neither the agent's queue nor its store's current branch, the wake
   *  starts no turn. */
  readsDeferredWrite?: string;
  /** Host-owned: this wake's sole cause is this message, stored in its
   *  agent's store as it arrived, not deferred (its row's id). Once a
   *  request that carried the message was answered and, for a wake that
   *  carries a channel and isn't marked `ambient`, the agent has since
   *  published into that channel having read it, or once the message isn't
   *  on its store's current branch, the wake starts no turn. */
  readsStoredMessage?: string;
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
   * redux). Undefined for non-channel wakes (heartbeat, timers, module events).
   * A heartbeat's turn takes no channel at all, and holds its plain speech as
   * drafts; any other falls back to the global default channel, except an
   * ephemeral run's (a subagent's), which takes no global fallback.
   */
  channelId?: string;
  /**
   * The server of `channelId`'s channel. MCPL requires a channel id to be
   * unique only within one server's connection (§14.2), so where two
   * servers register the same id only the pair names one channel. The
   * framework's own wakes set it beside `channelId`. A host's request that
   * gives `channelId` alone names the one channel that id, or its
   * server-qualified name (`serverId:channelId`), means; one that two
   * servers' channels answer to names none, and the turn's speech has no
   * channel of its own.
   */
  channelServerId?: string;
  /**
   * Framework-set: this wake carries an autoContinue continuation
   * (AgentConfig.autoContinue), with what its `[continue]` row says. The
   * scheduler keeps the mark on the turn's trigger only when the
   * continuation is that turn's whole cause, and the turn writes the row as
   * it starts. Hosts don't set it.
   */
  autoContinueRun?: AutoContinueRun;
  /**
   * Framework-set: whether this wake's turn is a heartbeat's, which has no
   * channel and holds its plain speech as drafts. True on a wake that
   * continues a heartbeat's turn with no channel of its own (an autoContinue
   * continuation, a bounce's resend wake, a ` !` continuation, and a re-arm,
   * which copies its trigger), and on a merged batch whose causes include a
   * heartbeat's wake and name no channel; false on a merged batch with none,
   * so the batch's first request doesn't decide it. Unset, a wake is a
   * heartbeat's when its `source` is `heartbeat`. Hosts don't set it.
   */
  heartbeatTurn?: boolean;
  /**
   * True when the triggering message explicitly addressed the agent (mention,
   * reply-to-bot, DM — `chat:addressed` in MCPL RFC-001 terms). When a wake
   * batch spans several channels, an addressed channel outranks ambient
   * chatter for the turn's frozen speech locus: overheard conversation must
   * not capture the agent's voice just by being newest.
   */
  addressed?: boolean;
  /**
   * Host-owned: true when the triggering message's server marked it ambient
   * (`chat:ambient`). A coalesced push's wake carries it only to read a
   * render, and only when every notice the render stands for was. Such a
   * message asked nothing of the agent, so a wake for it that carries
   * `readsDeferredWrite` or `readsStoredMessage` is dropped once a request
   * that carried the message was answered, with no publish asked of the
   * agent. A message with neither tag is in doubt, and is judged as an
   * addressed one.
   */
  ambient?: true;
  /**
   * Host-owned: true when the triggering message's server marked it a
   * `chat:system` notice (RFC-001 rev 3): an event about the place, such as
   * a join or the weather changing, not something anyone said. Such a wake
   * names no channel for its turn's plain speech, though it carries
   * `channelId`: a turn it starts alone resolves its locus as a heartbeat's
   * does. Like an ambient one, a wake to read it is done once read. Never
   * set on a coalesced render's wake, which may fold messages too.
   */
  systemNotice?: true;
  /**
   * Who spoke the message that triggered this inference, as an adapter-
   * namespaced opaque id (`<serverId>:user:<authorId>`) — never a display
   * name. Undefined for wakes without an author (heartbeat, timers, module
   * events). Read by the host to stamp gateway telemetry (x-gate-counterparty)
   * so a household ledger can say who woke whom; carries no content.
   */
  counterparty?: string;
  /**
   * Where the wake came from, for telemetry ONLY — never a speech locus.
   * Set by the EventGate for batched wakes (composite channel id of the
   * chosen event when the event carried one; push-event raw ids are not
   * used). Routing keeps reading `channelId`, set from registered ids: by
   * the direct channel paths, and by a gate wake only when its chosen event
   * addressed the agent and the host resolved that event's registered
   * channel (ambient-only batches leave it unset).
   */
  wakeChannelId?: string;
  /** Timestamp of the event the wake provenance was taken from (ms). */
  wakeAt?: number;
  /** Batched-wake lines the gate handed to this wake rather than wrote
   *  (WakeLine), decided by a fresh start of its turn as WakeLine says: each
   *  written once into the window it names, or left for a later fresh start
   *  of the same wake. A retry, or a start that resumes a logical turn,
   *  decides none. */
  wakeLines?: WakeLine[];
  /** Suppress every automatic plain-prose delivery for this logical turn.
   * Explicit tool calls remain available. Used by authenticated silent wakes. */
  suppressProse?: boolean;
  /** The authenticated silent heartbeat tick this turn answers. The rows the
   * turn's reply stores (its assistant responses and tool results) are
   * stamped `metadata.silentHeartbeat` with it, and request builds render a
   * request-only separator carrying the tick's instruction before the tick's
   * first surviving row (`SILENT_HEARTBEAT_SEPARATOR`). */
  silentHeartbeat?: SilentHeartbeatTick;
}
