/**
 * EventGate type definitions.
 *
 * The EventGate is a core framework component that evaluates incoming events
 * against declarative policies to decide whether they should trigger inference.
 * Policies are read from a `gate.json` file with hot-reload support.
 */

// ---------------------------------------------------------------------------
// Gate behaviors
// ---------------------------------------------------------------------------

/**
 * Token-bucket configuration for the `rate_limit` behavior.
 *
 * Each matching event consumes one token; events that arrive with an empty
 * bucket are denied (decision: trigger=false). Tokens regenerate at one per
 * `refillIntervalMs`, capped at `tokens`. Buckets are partitioned by the
 * value of `keyBy` resolved against event metadata — so a per-user limit
 * uses `keyBy: "senderId"`, a per-channel limit uses `keyBy: "channelId"`
 * (resolved to the channel's registered id, as `keyBy` says), etc. With no
 * `keyBy` (or when the resolved value is missing), one shared bucket is used
 * for the policy.
 */
export interface RateLimitConfig {
  /** Max bucket capacity, also the initial fill. Must be > 0. */
  tokens: number;
  /** Milliseconds between token regenerations. Must be > 0. */
  refillIntervalMs: number;
  /**
   * Metadata field name to partition buckets by. `"channelId"` takes the
   * channel's registered id where the gate resolves one, as `match.channel`
   * does, so a channel's push events share its messages' bucket, a voice
   * report's included, though it carries no `channelId`. Otherwise, if
   * absent or the metadata field is missing on a given event, all such
   * events share one bucket.
   */
  keyBy?: string;
}

/**
 * Counter configuration for the `passive_sample` behavior.
 *
 * Increments a counter on every match. When the counter reaches `every`,
 * the policy fires (trigger=true) and the counter resets to zero. Useful
 * for "decide whether to act every Nth observation" — chat passive
 * sampling, periodic analysis of sensor streams, etc. Counters are
 * partitioned by `keyBy` the same way `rate_limit` buckets are.
 */
export interface PassiveSampleConfig {
  /** Trigger every N-th match. Must be > 0. */
  every: number;
  /** Optional metadata field name for separate per-key counters, resolved
   *  as `RateLimitConfig.keyBy` is. */
  keyBy?: string;
}

/**
 * Configuration for the `judge` behavior: batch matching events as `debounce`
 * does, then, instead of waking the agent when the batch fires, ask a small,
 * cheap model (the host's reply judge, `GateOptions.judge`) whether now is a
 * good time for the agent to reply. The judge reads the agent's context as one
 * document (its newest part), the agent's own `instructions` and the batch,
 * and answers reply or wait. On reply the
 * batch is delivered as a debounce's is; on wait the agent isn't woken: the
 * events are in its context already, as for `defer`, and the next batch is
 * judged afresh. Rules are read in order, as ever: a mention rule placed ahead
 * of a judge rule wakes the agent without the judge. A judge that fails or
 * times out wakes the agent (fail open),
 * unless the host set its `onError` to `"skip"`.
 */
export interface JudgeConfig {
  /** Quiet period (ms) before the batch is judged, as `debounce`'s. */
  debounceMs: number;
  /**
   * The longest (ms) a batch waits from its first event before it's judged,
   * even while events keep arriving and pushing the quiet period back. Left
   * out, a batch is judged only after `debounceMs` of quiet, as a debounce
   * delivers.
   */
  maxWaitMs?: number;
  /**
   * The agent's own word to the judge: when it wants to be woken and when it
   * would rather stay quiet ("wake me when someone asks me something or the
   * talk turns to the garden; let banter between others go by"). Shown to the
   * judge with every batch this rule sends it.
   */
  instructions?: string;
}

/** How a matching policy affects inference triggering. */
export type GateBehavior =
  | 'always'    // Trigger inference immediately
  | 'defer'     // Don't trigger inference (event still enters context). Preferred name.
  | 'skip'      // Legacy alias for 'defer' (still accepted).
  | { debounce: number }                  // Batch events per-policy, deliver after delay (ms)
  | { rate_limit: RateLimitConfig }       // Token bucket per `keyBy`; deny when empty
  | { passive_sample: PassiveSampleConfig }  // Fire every Nth match
  | { judge: JudgeConfig };               // Batch like debounce, then ask the reply judge

// ---------------------------------------------------------------------------
// Policy match criteria
// ---------------------------------------------------------------------------

/** Criteria for matching an event. All specified fields must match (AND logic). */
export interface GatePolicyMatch {
  /** Event types to match (exact). Empty/omitted = all. */
  scope?: string[];
  /** ServerId to match (exact or glob with *). */
  source?: string;
  /** Channel to match (exact or glob with *): against the event's channel
   *  id, then the registered id the gate resolves for it
   *  (`resolveRouteChannel`). A channels/incoming message carries the
   *  registered id (`discord:<guild>:<channel>`), and a push the adapter's
   *  raw one or none, so a registered-form pattern meets every event in its
   *  channel whose push names the channel, and a raw id only push events. */
  channel?: string;
  /** Content text filter. */
  filter?: { type: 'text' | 'regex'; pattern: string };
  /**
   * Mount name to match (exact or glob with *). Populated for workspace
   * filesystem events (workspace:created/modified/deleted).
   */
  mount?: string;
  /**
   * Glob applied against each path in the event. Matches if ANY path matches.
   * Supports `*` wildcard; not full gitignore syntax.
   */
  pathGlob?: string;
  /**
   * Match when ANY listed metadata field is truthy (Boolean(metadata[name])).
   * Useful for OR-ing flag-style metadata, e.g.:
   *   metadataTrue: ["isMention", "isPrivate", "isReplyToBot"]
   * matches if any of those is set. Empty/omitted = no metadata constraint.
   */
  metadataTrue?: string[];
  /**
   * Tag matching (MCPL RFC-001 event tags). Globs allowed (e.g. `robotics:*`).
   * Evaluated against the event's (implication-expanded) tag set:
   *   tagsAny  — match if ANY listed pattern matches an event tag
   *   tagsAll  — match only if EVERY listed pattern matches some event tag
   *   tagsNone — match only if NO listed pattern matches any event tag
   * Combined with the other fields by AND, like the rest of the match.
   */
  tagsAny?: string[];
  tagsAll?: string[];
  tagsNone?: string[];
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** A single gate policy — one rule in the ordered policy list. */
export interface GatePolicy {
  name: string;
  match: GatePolicyMatch;
  behavior: GateBehavior;
  /**
   * Names of other policies whose state to clear when THIS policy fires
   * (decision.trigger === true). Lets you express interactions like "a
   * direct invocation should reset the passive-sample counter", without
   * coupling the behaviors to each other in code. Unknown names are ignored.
   */
  resets?: string[];
  /**
   * Observer semantics for the counting behaviors (`passive_sample`,
   * `rate_limit`): when the behavior does NOT fire for a matching event
   * (sampler below N, bucket empty), evaluation CONTINUES to later policies
   * instead of consuming the event with trigger=false. When it DOES fire,
   * it triggers as usual and evaluation stops.
   *
   * This is how to express "additionally wake me every Nth event" without
   * silently swallowing the events in between — a plain (consuming)
   * `passive_sample` placed early makes every later rule unreachable for
   * its scope, which is almost never what a density governor intends
   * (2026-08-08 Mythos stand-back-density incident). Validation rejects
   * `passthrough` on `always`/`defer`/`skip`/`debounce`, where "didn't
   * fire" has no meaning distinct from the behavior itself.
   */
  passthrough?: boolean;
  /**
   * Suppression: an event this rule takes is stored in the chronicle and
   * never rendered into the residents' context. It isn't compiled, injected
   * at a tool boundary, folded into memory, woken for, or counted as the
   * latest inbound. The framework decides this once, as the event arrives
   * (`EventGate.decideSuppression`), and stamps the row
   * (`metadata.suppressed = { rule, eventType }`). The view filters read only
   * that stamp, so changing the rule later never changes what was already
   * rendered or hidden: a removed rule stops suppressing from then on, and
   * the rows it hid stay hidden.
   *
   * The rule needs `behavior: "defer"` (or the legacy `"skip"`), so a release
   * that doesn't know `suppress` defers its events instead of waking the
   * agent on them, and a match that narrows something. Rules stay
   * first-match, with three exceptions: an event addressed to the agent
   * (`chat:addressed`), a heartbeat, and console or API input are never
   * suppressed. The rule lets them by, and the rules after it decide them.
   * A suppress rule decides no wake for an event suppression was asked about
   * (`evaluate` and `probe` pass over it there, `GateEventInfo.suppressionAsked`);
   * where suppression wasn't asked, it defers, as its behavior says.
   */
  suppress?: SuppressConfig;
}

/** A suppress rule's own settings (GatePolicy.suppress). */
export interface SuppressConfig {
  /**
   * What the rule is for, in the agent's words ("the eye going on and off").
   * Required: the periodic review (SuppressionReviewOptions), where the host
   * runs it, checks a sample of the events the rule hid against it.
   */
  description: string;
  /**
   * The agent's own logic for the rule, when matching isn't enough: the
   * source of a function `(event, state) => boolean`, called for each event
   * the rule's match takes that reaches it (one an earlier rule decides, an
   * addressed one, or the heartbeat's never does), only `true` hiding it. `event` is the event's type,
   * source, channel, author, tags, text, arrival time (`at`, ms) and
   * metadata. `state` is the rule's own JSON object, which the script reads
   * and changes as it likes, kept between events and across restarts
   * (suppress-scripts.ts), and started afresh when the script changes or the
   * rule is removed. So a rule can hide repeats, count, or keep a window of
   * its own. A script that throws or runs past its time counts as saying
   * show: the event goes on to the rules after it. Left out, every event the
   * rule matches is hidden.
   */
  script?: string;
}

/**
 * The periodic review of what suppress rules hid (src/gate/suppression-review.ts):
 * every `intervalMs`, for each rule that hid events since the last review, a
 * small model reads the rule's description and the events it hid (a sample,
 * past `maxEventsPerRule`) and flags any that don't fit the description or
 * that the agent would plausibly need to see. The agent is told what each
 * rule hid and what was flagged, in a `[suppression review]` notice; a
 * flagged event wakes it.
 */
export interface SuppressionReviewOptions {
  /** False turns the review off. Default true. */
  enabled?: boolean;
  /** How often, in ms. Default 2 hours; at least 10 minutes. */
  intervalMs?: number;
  /** The reviewer's model, as the host's membrane names it. Default `claude-haiku-5-5`. */
  model?: string;
  /** When the agent is told: after every review in which a rule hid something (`"always"`, the default), or only when an event was flagged (`"flagged"`). */
  notify?: 'always' | 'flagged';
  /** Whether a flagged event wakes the agent, which is a full turn of its own model, so a false flag costs that turn. Default true. */
  wakeOnFlag?: boolean;
  /** The most events of one rule the reviewer reads in one review, spread across the period. Default 60. */
  maxEventsPerRule?: number;
  /** How long one rule's review may take, in ms. Default 60,000. */
  timeoutMs?: number;
  /** The reviewer's effort (`output_config.effort`); `"none"` sends none. Default `"low"`. */
  effort?: 'low' | 'medium' | 'high' | 'none';
}

// ---------------------------------------------------------------------------
// Config (persisted as gate.json)
// ---------------------------------------------------------------------------

/** Top-level gate configuration, stored in gate.json. */
export interface GateConfig {
  policies: GatePolicy[];
  /** Behavior when no policy matches. Default: 'always'. */
  default?: 'always' | 'defer' | 'skip';
}

// ---------------------------------------------------------------------------
// FrameworkConfig-facing options
// ---------------------------------------------------------------------------

/** Options for configuring the EventGate via FrameworkConfig. */
export interface GateOptions {
  /** Path to gate.json. Default: derived from storePath. */
  configPath?: string;
  /**
   * The recipe's gate config. The first start seeds gate.json with it. Each
   * later start merges it into gate.json against the recipe last applied,
   * which the gate keeps beside gate.json (`gate.recipe.json`): a rule the
   * recipe dropped, renamed, moved or redefined follows it, a rule edited at
   * run time or by hand stays, and so does one no recipe declared. Rules are
   * merged by name, compared by what they mean and kept as written: a
   * recipe's rule with no name is never merged, as one with no name was never
   * added, and where gate.json or the recipe names a rule twice, a start only
   * adds the rules gate.json lacks. See `recipe-reconcile.ts`.
   */
  config?: GateConfig;
  /**
   * Path to a JSON file listing user ids that may wake the agent even while
   * it is asleep (`sleep` tool). The file is either a bare array of id
   * strings or `{ "userIds": [...] }`. Hot-reloaded on change. When unset or
   * missing, no one bypasses sleep.
   */
  privilegedUsersPath?: string;
  /** The reply judge that `judge` rules ask (see JudgeConfig). Left out (or
   *  null), the judge is wired with its defaults; it runs only for `judge`
   *  rules, so a gate with none makes no judge calls. */
  judge?: ReplyJudgeOptions | null;
  /**
   * The periodic review of what suppress rules hid (SuppressionReviewOptions).
   * On by default wherever a gate is; false turns it off.
   */
  suppressionReview?: SuppressionReviewOptions | false;
  /** How long a suppress rule's script may take for one event before the event is shown (ms). Default 50. */
  suppressScriptTimeoutMs?: number;
  /**
   * Wake onboarding (gate/wake-onboarding.ts): the first event from an MCPL
   * server that the agent's rules let go by without deciding about it brings
   * the agent that server's suggested treatment (MCPL RFC-001 §5), once per
   * declared ontology, with `wake_accept_suggestions` / `wake_decline` to
   * answer. On unless set to false.
   */
  onboarding?: boolean;
}

/**
 * Host options for the reply judge, the small model `judge` rules ask whether
 * now is a good time for the agent to reply. The host sets the model and how
 * the judge runs, not the agent: an agent's rule says when to ask and what to
 * say.
 */
export interface ReplyJudgeOptions {
  /** False leaves the judge unwired: `wake_add_rule` then offers no `judge`,
   *  and a `judge` rule in gate.json wakes the agent as a debounce of its
   *  `debounceMs` would, which gate_status says. Default true. */
  enabled?: boolean;
  /** The model the judge runs on, as the host's membrane names it. Default
   *  `claude-haiku-5-5`. */
  model?: string;
  /**
   * The most input tokens one judge request may carry, its instructions and
   * the batch included; the context document is cut from its oldest end to
   * fit. Default 90,000: Claude Haiku 5.5 costs five times as much past
   * 100,000 input tokens, and the margin covers the estimate's error. The
   * least is 4,000, a short tail of the conversation: cheaper and quicker,
   * with less of the room's history to weigh.
   */
  maxInputTokens?: number;
  /** The longest (ms) a judge request may take before the batch is decided by
   *  `onError`. Default 20,000. */
  timeoutMs?: number;
  /** What a judge that fails, times out or answers unreadably does: `"wake"`
   *  wakes the agent as a debounce would (the default, so a judge outage
   *  never silences the agent); `"skip"` doesn't. */
  onError?: 'wake' | 'skip';
  /** The judge's effort (`output_config.effort`). Default `"low"`: a short
   *  verdict, quickly. `"none"` sends no effort, for a provider that doesn't
   *  take Anthropic's `output_config`. */
  effort?: 'low' | 'medium' | 'high' | 'none';
  /** The prompt cache's lifetime for the judge's context document. `"5m"`
   *  (the default) suits judge rules that fire minutes apart; `"1h"` costs
   *  more to write and suits ones that fire less often. */
  cacheTtl?: '5m' | '1h';
}

/** One event of a batch, as the reply judge is shown it. */
export interface JudgeEventSummary {
  eventType: string;
  /** The channel as the agent is shown it, when the event named one. */
  channel?: string;
  /** The author's id, when the event named one. */
  authorId?: string;
  /** Whether the event addressed the agent (mention, reply, DM). */
  addressed: boolean;
  /** The event's text, cut short when long. */
  content: string;
  /** When the event arrived (ms). */
  at: number;
}

/** The kinds of UpcomingWake. */
export type UpcomingWakeKind =
  | 'heartbeat'
  | 'reminder'
  | 'self-wake'
  | 'sleep-end'
  | 'debounce'
  | 'judge-batch'
  | 'queued'
  | 'provider-hold';

/**
 * Something that will (or, for a batch going to the judge, may) wake the
 * agent with no new event: what the judge is told would happen if it answers
 * wait and nothing else arrives.
 */
export interface UpcomingWake {
  /** When (ms), when known; absent for one due as soon as the agent is free. */
  at?: number;
  /** False when it only may wake the agent (a judge rule's batch goes to the judge then). */
  certain: boolean;
  /** What it is, as the judge is told ("its own skip_reply timer"). */
  what: string;
  /** What it is, in a word that quotes nothing, for healthSnapshot: `what` can
   *  quote a reminder or a queue reason. The judge isn't told it. */
  kind?: UpcomingWakeKind;
}

/** What the gate asks the reply judge for one batch. */
export interface JudgeRequest {
  /** The rule whose batch this is. */
  policyName: string;
  /** The rule's `instructions`, the agent's own word to the judge. */
  instructions?: string;
  /** The batch, oldest first. */
  events: JudgeEventSummary[];
  /** The agents the batch would wake. */
  agentNames: string[];
  /** The gate's own timers that will wake those agents with no new event
   *  (upcomingWakes): their self-wakes, a sleep's end, other rules' pending
   *  batches. The judge adds what the framework knows besides. */
  upcomingWakes?: UpcomingWake[];
  /** Aborted when the judge's time is up or the gate is disposed. */
  signal: AbortSignal;
}

/** The reply judge's answer for one batch. */
export interface JudgeVerdict {
  /** True: wake the agent now. False: let the batch go by. */
  reply: boolean;
  /** The judge's one-line reason. */
  reason: string;
  /** The model that answered. */
  model?: string;
  /** Input tokens the request carried (all of them: uncached, cache reads and writes). */
  inputTokens?: number;
  /** Of those, the tokens read from the prompt cache. */
  cacheReadTokens?: number;
  outputTokens?: number;
}

/** The judge's function, as the framework wires it into the gate. */
export type JudgeFn = (request: JudgeRequest) => Promise<JudgeVerdict>;

// ---------------------------------------------------------------------------
// Runtime types (internal to EventGate, exported for tests/tools)
// ---------------------------------------------------------------------------

/** The result of evaluating an event against the gate. */
export interface GateDecision {
  /** Whether to trigger inference. */
  trigger: boolean;
  /** Name of the matching policy (null if default applied). */
  policyName: string | null;
  /** The behavior that was applied. */
  behavior: GateBehavior;
  /**
   * Names of `passthrough` policies that matched and counted this event but
   * did not fire, so evaluation continued past them. Absent when none did.
   */
  observed?: string[];
}

/**
 * A rule-ordering hazard: `earlier` matches (and consumes) every event that
 * `later` would match, for the listed event types — so `later` can never
 * fire for them. Produced by the conservative shadow lint; a warning here is
 * always a true statement about the config, but a config with no warnings is
 * not guaranteed hazard-free (the lint only proves what it can prove).
 */
export interface ShadowWarning {
  /** Name of the earlier (consuming) policy. */
  earlier: string;
  /** Name of the later policy whose events it takes. */
  later: string;
  /** Event types affected: those of `later`'s (its scope's, narrowed to the
   *  ones its source is known to send) that `earlier` covers. 'all' only when
   *  neither rule has a scope and `later`'s source could send any type. */
  eventTypes: string[] | 'all';
  /** Whether `earlier` takes every event `later` would match, so `later`
   *  never applies. */
  whole: boolean;
  /** Whether `later` is known to see these types: its scope names them, or
   *  its source is one whose event types the host knows (an MCPL server's).
   *  False when `later` names no scope and its source could send anything,
   *  so the types may never reach it. */
  known: boolean;
}

/** One row of the dry-run probe table (see EventGate.probeTable). */
export interface GateProbeRow {
  /** Short label for the synthetic event probed (e.g. "dm", "mention"). */
  probe: string;
  /** Event type the probe used. */
  eventType: string;
  /** Winning policy name, or null when the default applied. */
  policy: string | null;
  /** Compact behavior description (formatBehavior output or the default). */
  behavior: string;
  /** Whether this event WOULD trigger inference right now. For counting
   *  behaviors this reflects current counter/bucket state. */
  wouldWake: boolean;
}

/** Information about an event being evaluated. */
export interface GateEventInfo {
  content: string;
  eventType: string;
  serverId: string;
  channelId: string;
  metadata?: Record<string, unknown>;
  /** Workspace mount name (for workspace:* events). */
  mount?: string;
  /** Mount-prefixed paths touched (for workspace:* events). */
  paths?: string[];
  /** Event tags (MCPL RFC-001), already implication-expanded by the host. */
  tags?: string[];
  /**
   * Set when the framework asked whether the event is suppressed before it
   * asked about its wake (decideSuppression), so a suppress rule that
   * matches it let it by. Left out, a suppress rule defers the events it
   * matches, as its behavior says: suppression wasn't asked, as for an event
   * that lands where no view hides suppressed rows.
   */
  suppressionAsked?: boolean;
  /**
   * A coalesced render, which folds its batch's every occurrence while its
   * `tags` are the latest's (MCPL RFC-006): never taken as a `chat:system`
   * notice, as the render's own wake isn't, so a message it folds keeps
   * its channel when a notice came last.
   */
  folds?: true;
}

/** An MCPL event whose content the framework stored at arrival, as a
 *  batched wake names it to the framework (EventGate's `isNewestEntry`):
 *  a channel message by its server, channel and message id, a push event by
 *  its server and event id. */
export interface GateEntryRef {
  eventType: string;
  serverId?: string;
  channelId?: string;
  messageId?: string;
  eventId?: string;
}

/** A batched wake's `[Gate: …]` line that the gate handed to the wake rather
 *  than wrote: its batch was one event whose entry was still the newest in
 *  the window when the batch fired (EventGate's `isNewestEntry`). A fresh
 *  start of the wake's turn decides it (the framework's placeWakeLines): the
 *  delivery agent's own start leaves it out while that entry is still the
 *  newest, and writes it once something follows; a co-resident's start
 *  places none; two or more such lines are each written;
 *  and none is written while the host is quiesced or another reader of the
 *  residents' shared slot has a turn alive. A line left out stays for a
 *  later fresh start of the same wake. Its text is rendered when it's
 *  written (wakeLineText), so its age is true then.
 *
 *  Every request for one wake carries the same object: the framework writes
 *  each line once by its identity, across the wake's retries and holds. A
 *  host that hands the gate's requests on itself passes the line on as it
 *  is, not a copy per agent. */
export interface WakeLine {
  /** The event's own entry. */
  entry: GateEntryRef;
  policyNames: string[];
  /** The channel as the line names it to the agent. */
  shown: string;
  /** When the event arrived (ms): the line's age is counted from it to when
   *  the line is written (wakeLineText). */
  at: number;
  /** The channel the line names, as the omission's trace reports it. */
  channelId?: string;
}

/** Per-policy runtime statistics (for gate:status). */
export interface GatePolicyStats {
  name: string;
  behavior: GateBehavior;
  matchCount: number;
  lastMatchTimestamp: number | null;
  /**
   * Present on a suppress rule: its settings, and with a script, how the
   * script has run since this process started. Its `matchCount` and
   * `lastMatchTimestamp` count the events it took since then: those it
   * suppressed, and those it only deferred where suppression wasn't asked
   * (a channel under conversation routing). `suppression_stats` reads the
   * stamped rows themselves, so its counts cover every start.
   */
  suppress?: SuppressConfig & { scriptStatus?: import('./suppress-scripts.js').SuppressScriptStatus };
  debounceState?: {
    pendingCount: number;
    nextDeliveryMs: number | null;
  };
  /** Present for `rate_limit` behaviors. */
  rateLimitState?: {
    bucketCount: number;
    deniedCount: number;
  };
  /** Present for `passive_sample` behaviors. */
  passiveSampleState?: {
    counterCount: number;
    fireCount: number;
  };
  /** Present for `judge` behaviors. */
  judgeState?: {
    /** Events in the batch still waiting out its quiet period. */
    pendingCount: number;
    /** Whether the judge is deciding one of this rule's batches now. */
    judging: boolean;
    /** Events held for the judge until the agent's turn (or the host's quiesce) ends. */
    heldCount: number;
    /** Verdicts so far: woke the agent, let the batch go by, and judge failures. */
    verdicts: { reply: number; wait: number; error: number };
    /** The newest verdict. */
    last?: {
      at: number;
      verdict: 'reply' | 'wait' | 'error';
      reason: string;
      eventCount: number;
      durationMs: number;
      inputTokens?: number;
    };
  };
}

/** Full gate status returned by gate:status tool. */
export interface GateStatus {
  configPath: string;
  configSource: 'file' | 'initial' | 'default';
  lastReloadTimestamp: number | null;
  default: 'always' | 'defer' | 'skip';
  /** Status of the optional programmable gate (gate.js). */
  script: import('./gate-script.js').GateScriptStatus;
  policies: GatePolicyStats[];
  errors: string[];
  /**
   * Active shadow-lint findings for the current policy order (see
   * ShadowWarning). Rendered so an agent inspecting gate_status sees the
   * same hazards wake_add_rule warns about at install time.
   */
  shadowWarnings: string[];
  /**
   * The first rule that takes MCPL servers' events without naming a server, a
   * channel or a tag (gate/wake-onboarding.ts placementFor): every server
   * connected later is handled by it until a rule for that server goes ahead of
   * it. Absent when there is none.
   */
  catchAll?: { rule: string; note: string };
  /** Total events the gate has evaluated since startup. */
  totalEvaluations: number;
  /**
   * Count of events that fell through to `default` (no policy matched),
   * broken down by whether they triggered or were skipped. Useful for
   * spotting events that are arriving but silently dropped — if a policy
   * appears to never fire (matchCount 0) and this count is growing for the
   * same eventType, the event is reaching the gate but being dropped.
   */
  defaultDecisions: {
    triggered: number;
    skipped: number;
    byEventType: Record<string, { triggered: number; skipped: number }>;
  };
  /** Present when the agent is currently asleep (sleep tool). */
  sleep?: {
    until: number;
    remainingMs: number;
    note?: string;
    /** How many wake events have been suppressed during the current sleep. */
    suppressed: number;
    /** Count of privileged user ids that may wake through sleep. */
    privilegedCount: number;
  };
}
