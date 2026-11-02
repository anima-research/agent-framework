import type { JsStore } from '@animalabs/chronicle';
import type { Membrane } from '@animalabs/membrane';
import type { Module, EventResponse } from './module.js';
import type { AgentConfig, InferenceRequest } from './agent.js';
import type { ProcessEvent } from './events.js';
import type { McplServerConfig, InferenceRoutingPolicy } from '../mcpl/types.js';
import type { ConversationRouterConfig } from '../mcpl/conversation-router.js';
import type { GateOptions } from '../gate/types.js';
import type { InferenceBoundsOptions } from '../inference-bounds.js';

// Re-export trace types
export type { TraceEvent, TraceEventListener } from './trace.js';

/**
 * A module's response to a process event, tagged with the module name.
 */
export interface ModuleProcessResponse {
  moduleName: string;
  response: EventResponse;
  /**
   * Set when applying the response threw: the operation it threw at, such
   * as `the edit of <id>`, and the error's message. What the response asked
   * for before that was applied, that operation may have taken effect in
   * part or whole, and the rest of it wasn't (EventResponse).
   */
  threw?: { at: string; error: string };
}

/**
 * Configuration for process event logging.
 */
export interface ProcessLoggingConfig {
  /** Persist process logs to Chronicle (default: false) */
  persist?: boolean;
}

/**
 * Configuration for the agent framework.
 */
/**
 * Client-side programmatic tool calling: a synthesized `code_execution` tool
 * that runs model-authored JavaScript in QuickJS compiled to WebAssembly, in a
 * child process of its own per script, with the agent's tools as async
 * functions. Mirrors the trained surface of Anthropic's server-side PTC;
 * inner tool results never enter the model context.
 *
 * A script adds nothing to what its agent's tools allow, provided the host
 * runtime's WebAssembly engine and the glue around it are right. It claims no
 * containment beyond that: the child runs as the host's user, with an empty
 * environment and no operating-system sandbox around it.
 */
export interface CodeExecutionConfig {
  /** Master switch — only `true` synthesizes the tool. `create()` refuses a
   *  value that isn't a boolean, a quoted "false" included; `null` or leaving
   *  it out counts as off. */
  enabled: boolean;
  /** How long a run or a wait waits for its script before it yields, unless
   *  the agent asks otherwise with `yield_time_ms` (default 30_000 ms). */
  yieldMs?: number;
  /** The most an agent may ask a run or a wait to wait (default 600_000 ms).
   *  At least `yieldMs`. */
  maxYieldMs?: number;
  /** A script's limit: a script still running this long after it started is
   *  stopped, as "stopped at its limit" (default 86_400_000 ms, a day). */
  scriptLifetimeMs?: number;
  /** Scripts one agent may have running at once, yielded ones included
   *  (default 3). */
  maxRunningScripts?: number;
  /** Script processes the host runs at once, every agent's together
   *  (default 16). A run past it is refused at once, and nothing runs. */
  maxScriptChildren?: number;
  /** How long one of a script's tool calls may go unanswered before the
   *  script is told it timed out; the tool may still take effect
   *  (default 270_000 ms). */
  toolCallTimeoutMs?: number;
  /** Minimum interval between wake_agent() deliveries, ms (default 60_000).
   *  Early wakes are delayed, not dropped. */
  wakeMinIntervalMs?: number;
  /** Max wake_agent() calls per script (default 100); further calls are
   *  refused in the script. */
  maxWakesPerScript?: number;
  /**
   * The WebAssembly memory's maximum for each script, its budget: a whole
   * number of 64 KiB pages from 4 MiB to 2 GiB (default 128 MiB). A script's
   * process stays within about its runtime's base plus 2.7 times this, plus
   * what its calls take as they go out: up to about 200 MiB under Node and
   * 410 MiB under Bun. The host holds at most about 6 times this, plus 653 MiB,
   * plus 128 KiB for each wake maxWakesPerScript allows, for a script: about
   * 1.4 GiB at the defaults.
   * That's its 16 calls out at once, each with at most 4 MiB of JSON
   * arguments, timed-out ones whose tools still run included, up to 16 more
   * waiting as their text for those to end, up to 16 answers until the child
   * takes them, each at most a third of this, the frame from the child being
   * read, and its waiting wakes. A tool's
   * own result, and the one serialization the bridge makes of it to check its
   * size, are the tool's, beside this. Size a host by both. A call past the 16
   * the script waits on waits in the script, in this memory. A tool result too large for
   * it reaches the script as ResultTooLarge; how much fits depends on the
   * result's shape (see `IsolateSettings.memoryMaxBytes`).
   */
  memoryMaxBytes?: number;
}

/** See `FrameworkConfig.providerHold`. */
export interface ProviderHold {
  holdMs: number;
  /** Operator-facing explanation, logged with the hold. */
  reason?: string;
}
/** What the framework knows about the failing call. */
export interface ProviderHoldContext {
  /** Model of the agent whose call failed — a quota window may be model-scoped. */
  model?: string;
}
export type ProviderHoldHook = (
  error: Error, agentName: string, context: ProviderHoldContext,
) => ProviderHold | undefined;

export interface FrameworkConfig {
  /**
   * Dendrite agent lifecycle options.
   */
  dendrite?: {
    /**
     * When an agent ends while task work it spawned is still running, the
     * orphan is always told. With this on (the default), the first agent
     * that could adopt it — its nearest live ancestor, else the primary —
     * also receives a factual notice, which is what makes the reparenting
     * offer visible to a model. Turn it off when the host makes adoption
     * decisions itself from the `dendrite:agent-orphaned` trace.
     */
    announceOrphans?: boolean;
    /**
     * With a `derivationNotice`, after this many derivations of one kind from
     * one agent, the line it's given is a count line every so many instead of
     * a line per fork, so a reader loop that forks a hundred times a session
     * doesn't fill its source's context with stamps; every derivation still
     * emits its `dendrite:agent-created` trace. Default 10; 0 never collapses.
     * Without a `derivationNotice` the source is told nothing.
     */
    collapseDerivationNoticesAfter?: number;
    /**
     * A host's say over each derivation, ephemeral spawn and resume, before the
     * agent or its new incarnation exists, given the spec of what is about to
     * exist (name, kind, spawner, route, inheritance, metadata). A shared
     * derivation's record then adds the child's branch, and names the
     * parent's namespace as its own. Return nothing to allow, or `{ refuse }`
     * with the reason, which the caller gets as the error. The framework
     * attaches no meaning to the decision: consent, budget, hours, a mind's
     * standing instruction, a use not yet imagined are all the host's.
     */
    beforeDerive?: (spec: import('../dendrite/types.js').AgentSpec) => void | { refuse: string };
    /**
     * What an agent is told when something is derived from it. Given the
     * record, the agent it was derived from and the framework's own line,
     * return the text to add (that line, or the host's own), or null to add
     * nothing. Absent, nothing is added: an agent isn't told of derivations
     * unless the host asks for it. The `dendrite:agent-created` trace is
     * emitted either way.
     */
    derivationNotice?: (record: import('../dendrite/types.js').AgentRecord, from: string, defaultText: string) => string | null;
  };

  /**
   * The subconscious resident (issue #77): a persistent side-agent that
   * receives diverted traffic from tuned-out channels and reports to the
   * resident in its own voice. See src/tune-out/tools.ts.
   */
  subconscious?: import('../tune-out/tools.js').SubconsciousConfig;

  /**
   * Tune-out without a reader (issue #232 §3.3). The hold machinery always
   * runs when MCPL channels exist, so a persisted epoch is resumed and
   * released whatever the configuration; this switch only decides whether
   * residents are offered `tune_out` when no reader is configured. Without
   * a reader a tune-out is a silent hold: no cadence, no wake budget,
   * mentions are acknowledged, the backlog is released on cancel.
   */
  tuneOut?: {
    /** Offer `tune_out` without a subconscious. Default: only with one. */
    enabled?: boolean;
    /**
     * Announce the all-except scope in the excepted channel: one bracketed
     * line under the resident's name when it opens (who, for how long) and
     * one when it closes. Default true — a hold the room cannot see is the
     * failure the scope exists to prevent. `false` keeps both quiet.
     */
    announce?: boolean;
  };

  /**
   * Where a turn's plain prose lands when nothing names a destination
   * (architecture channel, 2026-10-06: the §3 carve-out accepted by the
   * residents).
   *
   * - `'delivery'` (default): the locus comes only from the delivery that
   *   woke the turn, a conversation fork's home channel, or a channel the
   *   agent opened during the turn. Incoming traffic never moves it — not
   *   between turns, not mid-turn. A turn with no such locus keeps its
   *   prose private, and says so in a `[routing]` notice.
   * - `'latest-inbound'`: the previous rule. The most recent delivered
   *   inbound message is a global fallback locus for turns without one, and
   *   an addressed message injected mid-turn re-pins the turn's locus.
   *
   * Held traffic never moves the locus under either rule.
   */
  speech?: {
    locus?: 'delivery' | 'latest-inbound';
  };

  /**
   * IANA zone of the agent's wall clock: it renders wall-clock times for the
   * agent, and it sets where clock rows' boundaries fall (AgentConfig.clock,
   * counted from local midnight here). Stored/protocol timestamps remain
   * epoch/UTC. Defaults to AGENT_TIMEZONE, then the process zone.
   */
  timeZone?: string;

  /** Path to Chronicle store */
  storePath?: string;

  /**
   * Branch-independent Discord awareness ledger. Defaults to
   * `<storePath>/recovery/discord-awareness-outbox.json`. Set explicitly when
   * providing an app-owned `store` without `storePath`; with neither, the
   * framework has no ledger and refuses a marks choice.
   */
  discordAwarenessOutboxPath?: string;

  /**
   * Branch-INDEPENDENT record of the host's quiesce state (issue #122).
   * Defaults to `<storePath>/recovery/host-mode.json`. Lives outside the
   * chronicle because a historical rollback (branchAt + switchBranch) would
   * otherwise move the active branch to a version of `framework/state`
   * predating the marker, and a restart would boot SERVING mid-surgery. Set
   * explicitly when providing an app-owned `store` without `storePath`;
   * without either, the branch-local slot is used with a one-time warning.
   */
  hostModePath?: string;

  /**
   * Branch-independent durable queue of context writes deferred while
   * quiesced. Defaults to `<storePath>/recovery/deferred-writes.json`; same
   * rationale and fallback as `hostModePath`.
   */
  deferredWritesPath?: string;

  /**
   * The Dendrite agent registry's recovery file: its live records and the
   * results it holds for delivery, written atomically and fsynced, and read
   * first at boot. Defaults to `<storePath>/recovery/dendrite-registry.json`.
   * Outside the chronicle for the reason `hostModePath` is: a branch switch
   * or historical rollback would otherwise take back held results. Set
   * explicitly when providing an app-owned `store` without `storePath`;
   * without either, the registry persists only in the branch-local store,
   * with a warning at create.
   */
  agentRegistryPath?: string;

  /**
   * The registry's ended-record log recovery file (its newest records, as
   * many as a restart reads). Defaults to
   * `<storePath>/recovery/dendrite-ended.json`; same rationale and fallback
   * as `agentRegistryPath`.
   */
  agentRegistryEndedPath?: string;

  /** Emoji used for branch-awareness markers (default: 💤). */
  discordAwarenessEmoji?: string;

  /**
   * Durable JSONL record of operator-initiated mutations (rollback, suppress,
   * undo/hide, settings, quiesce). Defaults to
   * `<storePath>/operator-actions.jsonl`; set explicitly when providing an
   * app-owned `store` without `storePath`. `false` disables the file (actions
   * still emit `operator:action` traces).
   */
  operatorLogPath?: string | false;

  /**
   * Mandatory deadline for each Discord awareness marker tools/call. This is
   * independent of MCPL requestTimeoutMs and cannot be disabled with 0.
   * Values are clamped to 50..60000ms; 0 selects the 10000ms default.
   */
  discordAwarenessDeadlineMs?: number;

  /** Or existing store (app-owned) */
  store?: JsStore;

  /** Membrane instance for LLM calls */
  membrane: Membrane;

  /** Agent configurations */
  agents: AgentConfig[];

  /** Modules to load */
  modules: Module[];

  /** Custom inference policy */
  inferencePolicy?: InferencePolicy;

  /** Custom error policy */
  errorPolicy?: ErrorPolicy;

  /**
   * How long a model call may go without progress before it is cut. A
   * resident's streamed call, and an MCPL server's, gets membrane's progress
   * bounds where its adapter's stream reports content (Anthropic, Bedrock),
   * and on every adapter a flat bound from its last provider event: the
   * larger of a setup term (the larger of `beforeContentMs` and
   * `betweenEventsMs`) plus the request's `maxTokens` at
   * `thinkTokensPerSecond`, and `flatMinimumMs`. An auxiliary call
   * (compression, the reply judge) and an MCPL server's non-streamed call get
   * a bound on the whole call from its send, the setup term plus that
   * allowance (the larger of the setup term and `flatMinimumMs` when it
   * names no `maxTokens`), unless its
   * caller passed a `progressTimeoutMs` of its own; where an adapter's
   * `complete()` streams under the hood, membrane renews it at each parsed
   * provider event. A call a bound cuts fails
   * with type `timeout`, and on an agent's turn DefaultErrorPolicy gives each
   * such call one fresh call, except in a turn that re-arms an exhausted one,
   * where `exhaustedTurnRearmMs` says what a cut does. One setting covers
   * every agent. `false` sets
   * none of these bounds. Default: membrane's PROGRESS_BOUNDS and
   * FLAT_MINIMUM_MS.
   */
  inferenceBounds?: false | InferenceBoundsOptions;

  /**
   * Host verdict on a failed inference: "this cannot succeed until later".
   * Consulted before the error policy and before the built-in
   * organization-acceleration classification, for a persistent agent's
   * primary inference and for its auxiliary (compression) calls. Ephemeral
   * runs (subagents) and conversation forks are NOT covered: they have no
   * provider-admission gate and keep the ordinary error policy. A hold parks the agent's provider
   * admission (primary and auxiliary) instead of retrying, and — like the
   * built-in organization-acceleration cooldown — records no failed turn and
   * does not feed the hard-down streak. The motivating case is a subscription
   * credential whose quota window is spent: its 429 looks like a throttle,
   * but retrying cannot help until the window resets.
   *
   * Holds are served in slices of at most 10 minutes. When a slice expires
   * the hook is consulted again with the same error, before any inference is
   * attempted; it extends the hold by returning another, or releases it by
   * returning undefined. Must be synchronous and cheap; a throwing hook is
   * treated as "no hold".
   */
  providerHold?: ProviderHoldHook;

  /**
   * Delays before a turn whose retries ran out is sent again, in ms (default
   * `[120000, 480000, 1920000]`: 2, 8 and 32 minutes), or `false` never to.
   * When a persistent agent's turn ends exhausted on a transient failure (a
   * server error, an overload, a rate limit, a network failure, or a timeout
   * membrane marks retryable and not as a deadline it reports as run out, such
   * as a 408 or a socket's ETIMEDOUT), its trigger is queued again after the
   * first delay, as a wake of its own. It opens where the exhausted turn's
   * plain speech was going: its locus, where a message mid-turn may have moved
   * it, else its trigger channel. Carrying that channel, it ranks as addressed
   * in a merged wake's choice of channel, so a newer ambient wake from
   * elsewhere doesn't take it; an autoContinue continuation's still yields its
   * channel to any wake's, as it does on main; a continuation's, such as a
   * budget restart's, names no author. A re-arm that would have to guess a
   * channel isn't sent again: one whose turn was woken for a channel id that
   * names no one registered channel and never found one, and whose request
   * names none of its own. A failure that states a wait is held for that wait
   * first, as any turn's is, and a turn that ends on a deadline, whether the
   * host set it or membrane marks one as run out (the runtime's or undici's
   * on a sent request, the Anthropic adapter's watchdogs, or the Anthropic
   * SDK's timeout, which covers its connect timeout too), isn't re-armed,
   * save the exception below. Until one of the re-armed turn's rounds has run
   * or had its tool calls cut off, its failure gets no retries from the error
   * policy: on another transient failure the next delay follows, until the
   * list runs out, and a failure of any other kind ends the re-arming. The
   * one exception is a re-armed turn's send that fails with a deadline marked
   * as run out, membrane's or a bound the host sets on the call
   * (`inferenceBounds`), as when a stream stalls. Such a cut counts as a
   * transient failure, so a turn that ends on it is re-armed as for a
   * transient failure, unless it follows another such cut with no transient
   * failure, answered round or message said to the agent between them: two
   * such cuts in a row end the re-arming, and the second gets no retry from
   * the error policy, even in a re-armed turn that got partway. A transient
   * failure or an answered round in any of the agent's turns clears an
   * earlier cut, and so does a message said to the agent, or the agent's end.
   * Every such cut counts, including one the error policy retries or a host's
   * provider hold takes. A wake for the agent while it waits starts its turn
   * at once, with the re-armed trigger merged in. That turn is the
   * wake's: the error policy retries its failures. A completed turn starts the
   * count again, and so does a message said to the agent: not a system message
   * or notice; not an edit, reaction or deletion, unless an edit is the first
   * version of a message the agent sees; not a message its own view leaves
   * out, such as one a tune-out holds from it; and not the agent's own
   * schedule, the heartbeat's tick or reminder, a self-wake timer it set, or a
   * script's wake. A notice a module or an MCPL server stores as a message
   * counts. A message in the residents' shared slot counts for each resident
   * that reads it. Any other wake leaves the count going on. A re-armed turn's
   * transient failure writes no `[inference-failed]` marker unless a round of
   * it ran or had its tool calls cut off; any other failure of it writes one.
   * Each counts toward the hard-down streak. Ephemeral runs and conversation
   * forks are never re-armed. The wait and the count are kept in memory:
   * `stop()` drops them, and so does a restart. The wait isn't a turn, so
   * `abortInference()` doesn't end it.
   */
  exhaustedTurnRearmMs?: number[] | false;

  /** Interval for periodic store sync in milliseconds (default: 1000ms, 0 to disable) */
  syncIntervalMs?: number;

  /**
   * Interval for queued context-maintenance polling in milliseconds
   * (default: 5000ms, 0 to disable). Each pass refreshes the agent's live tool
   * definitions, then advances pending compression/indexing work.
   */
  maintenanceIntervalMs?: number;

  /** Process logging configuration (default: disabled) */
  processLogging?: ProcessLoggingConfig;

  /** MCPL server configurations. If omitted or empty, no MCPL subsystems are created. */
  mcplServers?: McplServerConfig[];

  /**
   * Client-side programmatic tool calling (`code_execution` tool). Omitted or
   * `enabled: false` → tool absent, and no script's process is ever started. At runtime,
   * untyped configs may also use `null` or `false` to omit this setting.
   * Other values that aren't objects are refused at `create()`.
   */
  codeExecution?: CodeExecutionConfig;

  /**
   * Durable inline cap (chars) for tool results — successes AND errors — and
   * script wake payloads (wake_agent()). Content over the cap is written to a
   * workspace file under `tool-results/` (deterministic `<date>-<callId>.txt`
   * name, overwritten on collision, retained until the workspace owner
   * deletes it — never auto-GC'd) and replaced inline by a bounded preview
   * plus the file reference; with no writable mount without an include that
   * keeps its files in the store (not configured direct), the fallback is
   * explicit plain truncation. Default 24000 (house-safe; issue #89). Must be
   * >= 1000. A resident's own agent_settings value
   * `tool_result_inline_max_chars` (durable, persisted in framework state)
   * takes precedence over this for that agent; the EFFECTIVE cap for every
   * source is min(desired, strategy bound) — desired values above the
   * strategy-derived bound (maxMessageTokens * 4) are hard-clamped to it,
   * with the clamp reported via agent_settings get. For an ordinary resident
   * the bound is the smallest among the agents that read the shared slot,
   * reported as clamped by `reader-bound` when another reader's sets it.
   */
  toolResultInlineMaxChars?: number;

  /**
   * MCPL RFC-008 operator class overrides: RFC-007 §6.2 patterns over the
   * model-facing tool name → classes. Highest-precedence source of a tool's
   * effective class (first matching pattern wins); replaces, never merges
   * with, what the providing server declared. Use it to correct or tighten a
   * misclassed tool.
   *
   * MCPL tools are named `<toolPrefix>--<tool>`, and toolPrefix defaults to
   * `mcpl--<serverId>`: server `search` without a toolPrefix needs
   * `mcpl--search--*`, not `search--*`. A pattern that matches no tool is
   * reported once its servers have listed their tools.
   */
  toolClassOverrides?: Record<string, string[]>;

  /**
   * MCPL RFC-008 host knowledge for tools the EMBEDDING host implements (its
   * own modules), same shape as toolClassOverrides. Consulted before the
   * framework's built-in table and never for MCPL-provided tools, whose
   * class comes from an override or their server's `_meta["mcpl/class"]`.
   */
  hostToolClasses?: Record<string, string[]>;

  /**
   * Inference routing policy for server-initiated inference (optional): the
   * model an MCPL server's inference/request runs on. Without one, each such
   * request is refused with -32603 and a message naming this setting; the
   * framework doesn't choose a model for a server. A server's effective
   * grant can still list `inferenceRequest` then, since the grant comes from
   * what the server advertises and `enabledCapabilities`, not from this
   * policy. A policy that names no model for a request's feature set (no
   * override, byFeature or wildcards entry that names one, and an empty
   * `default`) refuses that request the same way, naming the feature set.
   */
  inferenceRouting?: InferenceRoutingPolicy;

  /** EventGate config. If omitted, all events trigger inference (unchanged default). */
  gate?: GateOptions;
  /**
   * The heartbeat: the agent's own periodic check-in and reminders, kept by
   * the framework (src/heartbeat/heartbeat.ts), with the tools
   * `heartbeat--heartbeat_status`, `heartbeat--heartbeat_configure`,
   * `heartbeat--heartbeat_trigger`, `heartbeat--reminder_add`,
   * `heartbeat--reminder_list` and `heartbeat--reminder_cancel`. `true` turns it
   * on with its defaults; `false`, null or leaving it out leaves it off. Its
   * wakes go to the gate as heartbeat-mcpl's pushes did, from the server id
   * `heartbeat`, so the agent's rules decide them and a sleep lets them
   * through. It replaces the heartbeat-mcpl server, which is refused beside it
   * (by its id, a heartbeat tool prefix, or its command), at create and at a
   * runtime connect: both would wake the agent. `importFrom` brings that
   * server's schedule and reminders along.
   */
  heartbeat?: boolean | null | import('../heartbeat/heartbeat.js').HeartbeatOptions;

  /**
   * Liveness watchdog: fail hard (and let the supervisor restart) if the main
   * thread wedges — a synchronous infinite loop or microtask flood that would
   * otherwise leave the agent silently deaf. Off unless `enabled` is set.
   */
  watchdog?: {
    enabled?: boolean;
    /** Kill if no heartbeat for this long (ms). Default 30000. */
    thresholdMs?: number;
    /** 'abort' → SIGABRT (core dump for debugging); 'exit' → SIGKILL. Default 'abort'. */
    action?: 'abort' | 'exit';
    /** Optional path for a JSON wedge report written before the kill. */
    reportPath?: string;
  };

  /**
   * Per-channel conversation routing. When set, incoming MCPL channel
   * messages route to per-channel fork agents spawned from the template
   * agent instead of the primary conversation. If omitted, behavior is
   * unchanged (all messages go to the primary agent).
   *
   * @deprecated Per-channel conversation routing is deprecated and will be
   * removed (anima-research/agent-framework#235). Its 'mention' bind/trigger
   * rule reads `metadata.mentioned`, which not every channel server sets
   * (discord-mcpl does not), so on those channels an @-mention neither binds
   * a fork nor triggers a bound one. Routing still works for now; the
   * framework logs one `[deprecated]` line at creation when this is set.
   */
  conversations?: ConversationRouterConfig;
}

/** One agent's outcome within a periodic context-maintenance pass. */
export interface ContextMaintenanceAgentRun {
  agentName: string;
  startedAt: number;
  finishedAt?: number;
  ticks: number;
  readyBefore: boolean;
  readyAfter?: boolean;
  pendingBefore?: string;
  pendingAfter?: string;
  progressBefore?: Record<string, unknown>;
  progressAfter?: Record<string, unknown>;
  /**
   * The agent's failure in this pass: a tick that threw, or its readiness
   * that couldn't be read, before the ticks or after them.
   */
  error?: string;
}

/** A bounded periodic context-maintenance pass. */
export interface ContextMaintenanceRun {
  id: number;
  startedAt: number;
  finishedAt?: number;
  agents: ContextMaintenanceAgentRun[];
}

/** Debug-safe maintenance state. Contains counts and errors, never messages. */
export interface ContextMaintenanceSnapshot {
  intervalMs: number;
  ticksPerPass: number;
  current: ContextMaintenanceRun | null;
  history: ContextMaintenanceRun[];
  agents: Array<{
    agentName: string;
    ready: boolean;
    pending?: string;
    /**
     * Why the agent's readiness can't be read: the context manager refuses
     * while its strategy's initialization is pending or has failed, and a
     * strategy can refuse on its own. `ready` is false then.
     */
    error?: string;
    progress?: Record<string, unknown>;
  }>;
}

/**
 * Policy for deciding when to run inference.
 */
export interface InferencePolicy {
  /**
   * Decide whether to run inference for an agent.
   */
  shouldInfer(
    agentName: string,
    requests: InferenceRequest[],
    state: FrameworkState
  ): boolean;
}

/**
 * Policy for handling errors.
 */
export interface ErrorPolicy {
  /**
   * Handle an inference error. `attempt` is how many times the turn's
   * request has failed before this one; for a deadline expiry (a progress
   * bound's cut, or one membrane marks), how many times that call's request
   * has expired in a row before this one.
   */
  onInferenceError(
    error: Error,
    agentName: string,
    attempt: number
  ): ErrorAction;

  /** Maximum retry attempts */
  maxRetries: number;
}

/**
 * Action to take after an error.
 */
export type ErrorAction =
  | { retry: true; delayMs: number }
  | { retry: false; emit?: ProcessEvent };

/**
 * Terminal result for a framework-driven ephemeral agent run.
 */
export interface AgentSettleResult {
  stopReason: 'completed' | 'turn_ended' | 'exhausted';
  speech: string;
  toolCallsCount: number;
  error?: string;
}

/**
 * Framework state exposed to policies.
 */
export interface FrameworkState {
  /** Get agent status */
  getAgentStatus(name: string): import('./agent.js').AgentState | null;

  /** Get module by name */
  getModule(name: string): Module | null;

  /** Get all pending inference requests */
  getPendingRequests(): InferenceRequest[];

  /** Current queue depth */
  queueDepth: number;
}

/**
 * Entry in the inference log.
 */
export interface InferenceLogEntry {
  timestamp: number;
  agentName: string;
  requestId: string;
  /** Whether inference succeeded */
  success: boolean;
  /** Why it didn't succeed: the failure's message, or what stopped it */
  error?: string;
  /** Request data or blob ID if large. A stream the framework ended at a
   *  tool boundary (stopReason 'turn_ended', 'context_budget' or
   *  'physical_window') records a note in place of the body. */
  request: unknown | { blobId: string };
  /** Response data or blob ID if large (only if successful) */
  response?: unknown | { blobId: string };
  durationMs: number;
  /** The stream's usage: its final response's, or, for a stream that ended
   *  without one, the provider rounds it finished before it ended. Exactly
   *  one entry of a stream carries it, the one its end wrote, a stop's
   *  included; a stream whose end writes none (a superseded stream, a
   *  disposed agent's stream) gets a failure entry that carries it, when it
   *  had finished a round. One that hadn't has nothing to carry and gets no
   *  entry. */
  tokenUsage?: {
    input: number;
    output: number;
    cacheCreation?: number;
    cacheRead?: number;
  };
  /** Stop reason from the model, or why the framework ended the stream at a
   *  tool boundary: 'turn_ended' (a tool result with endTurn), or
   *  'context_budget' / 'physical_window' (a context-budget or
   *  physical-window restart). */
  stopReason?: string;
}

/**
 * Entry in the process log - records a processed event with the module
 * responses that applied.
 */
export interface ProcessLogEntry {
  timestamp: number;
  /** The process event that was handled */
  processEvent: ProcessEvent;
  /** The modules' responses that applied, or blob ID if large. A response
   *  refused for content context-manager won't store is left out; its stderr
   *  line and process:response-refused trace name it. */
  responses: ModuleProcessResponse[] | { blobId: string };
}

/**
 * Query options for process logs.
 */
export interface ProcessLogQuery {
  /** Filter by process event type */
  eventType?: string;
  /** Filter by module name (modules whose responses applied) */
  moduleName?: string;
  /** Max number of logs to return */
  limit?: number;
  /** Skip first N logs (for pagination) */
  offset?: number;
  /** Search pattern for content (regex) */
  pattern?: string;
}

/**
 * Result from querying process logs.
 */
export interface ProcessLogQueryResult {
  entries: ProcessLogEntryWithId[];
  total: number;
  hasMore: boolean;
}

/**
 * Process log entry with Chronicle sequence ID.
 */
export interface ProcessLogEntryWithId {
  sequence: number;
  entry: ProcessLogEntry;
  /** Summary for display without resolving blobs */
  summary?: ProcessLogSummary;
}

/**
 * Summary view of a process log (without full responses).
 */
export interface ProcessLogSummary {
  timestamp: number;
  eventType: string;
  moduleCount: number;
  /** Modules that requested inference */
  modulesRequestingInference: string[];
  /** Modules that added messages */
  modulesAddingMessages: string[];
  /** Whether responses are stored as blob */
  responsesIsBlob: boolean;
}
