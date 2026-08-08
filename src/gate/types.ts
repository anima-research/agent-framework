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
 * uses `keyBy: "senderId"`, a per-channel limit uses `keyBy: "channelId"`,
 * etc. With no `keyBy` (or when the resolved value is missing), one shared
 * bucket is used for the policy.
 */
export interface RateLimitConfig {
  /** Max bucket capacity, also the initial fill. Must be > 0. */
  tokens: number;
  /** Milliseconds between token regenerations. Must be > 0. */
  refillIntervalMs: number;
  /**
   * Metadata field name to partition buckets by. If absent or the metadata
   * field is missing on a given event, all events share one bucket.
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
  /** Optional metadata field name for separate per-key counters. */
  keyBy?: string;
}

/** How a matching policy affects inference triggering. */
export type GateBehavior =
  | 'always'    // Trigger inference immediately
  | 'defer'     // Don't trigger inference (event still enters context). Preferred name.
  | 'skip'      // Legacy alias for 'defer' (still accepted).
  | { debounce: number }                  // Batch events per-policy, deliver after delay (ms)
  | { rate_limit: RateLimitConfig }       // Token bucket per `keyBy`; deny when empty
  | { passive_sample: PassiveSampleConfig };  // Fire every Nth match

// ---------------------------------------------------------------------------
// Policy match criteria
// ---------------------------------------------------------------------------

/** Criteria for matching an event. All specified fields must match (AND logic). */
export interface GatePolicyMatch {
  /** Event types to match (exact). Empty/omitted = all. */
  scope?: string[];
  /** ServerId to match (exact or glob with *). */
  source?: string;
  /** ChannelId to match (exact or glob with *). */
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
  /** Initial config, seeded to gate.json if the file doesn't exist. */
  config?: GateConfig;
  /**
   * Path to a JSON file listing user ids that may wake the agent even while
   * it is asleep (`sleep` tool). The file is either a bare array of id
   * strings or `{ "userIds": [...] }`. Hot-reloaded on change. When unset or
   * missing, no one bypasses sleep.
   */
  privilegedUsersPath?: string;
}

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
  /** Name of the later policy it makes unreachable. */
  later: string;
  /** Event types affected — 'all' when both rules are unscoped. */
  eventTypes: string[] | 'all';
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
}

/** Per-policy runtime statistics (for gate:status). */
export interface GatePolicyStats {
  name: string;
  behavior: GateBehavior;
  matchCount: number;
  lastMatchTimestamp: number | null;
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
