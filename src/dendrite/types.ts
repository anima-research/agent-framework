/**
 * Dendrite — common agent / context / lifecycle machinery.
 *
 * One registry describes every agent the framework runs: residents, fresh
 * workers and derived agents. The four historical creation paths (resident,
 * subconscious, conversation fork, ephemeral subagent) are PRESETS over the
 * types in this file, not separate engines: the framework never branches on
 * what kind of agent something is, only on what its spec declares.
 *
 * Three things are kept apart on purpose:
 *
 * - **Identity / lifetime** — what persists across activations: the name,
 *   the context it owns, its configuration, its relationships.
 * - **Activation** — one bounded run, with an owner for the in-flight work.
 * - **Policy epoch** — a focus / tune-out interval. Ending an epoch is not
 *   ending an agent and not cancelling a task; epochs stay owned by the
 *   policy coordinator and are only *read* through the registry.
 *
 * Trust: one host trust domain. Context isolation here is NOT process or
 * filesystem isolation — agents sharing a shell, tools or a workspace can
 * affect shared external state. Nothing in this file is a permission check.
 */

/** A registered agent's name. Unique among live agents. */
export type AgentName = string;

/**
 * Preset label, for discovery and telemetry ONLY. Framework behaviour is
 * decided by {@link AgentRoles}, {@link AgentLifetime} and the relationship
 * fields — never by comparing this string.
 */
export type AgentKind =
  | 'resident'
  | 'subconscious'
  | 'conversation-fork'
  | 'task-fork'
  | 'worker'
  | (string & {});

/**
 * Positive capabilities. Each replaces a family of hand-written exclusion
 * filters; a new kind of agent declares these instead of editing every
 * selection site.
 */
export interface AgentRoles {
  /**
   * Owns default delivery: a framework message with no named recipient lands
   * in this agent's context. Exactly one live agent holds it.
   */
  defaultDelivery: boolean;
  /**
   * Woken by untargeted inbound: a module's `requestInference: true`, a
   * channel message or push event that names no agents, and the default
   * reader set of a coalesced occurrence.
   */
  receivesUntargeted: boolean;
  /**
   * Woken by host-wide gate fan-out (debounce batches, sleep expiry). The
   * gate is host-wide today; this stays a separate capability from
   * `receivesUntargeted` until gating is per recipient, because a
   * channel-bound agent is woken by its own channel's debounced traffic
   * without being a broadcast recipient.
   */
  receivesGateWakes: boolean;
  /**
   * Provider admission belongs to it: it holds the per-agent provider gate
   * for its primary calls and owns rate-limit cooldowns and the requests
   * held behind them. Agents without it run under the established provider
   * policy and never leave a gate or cooldown behind when they end.
   */
  ownsProviderScheduling: boolean;
}

/**
 * How long the IDENTITY lives. Every activation of every agent is bounded
 * separately (see {@link ActivationBounds}); a persistent agent is exempt
 * from ending, not from activation bounds.
 */
export type AgentLifetime =
  /** Declared in configuration and re-created at boot. */
  | { kind: 'persistent' }
  /** Ends after a period with no inbound on its binding. */
  | { kind: 'idle'; idleTtlMs: number }
  /**
   * A bounded job: must end. At least one of `deadlineMs` (wall clock from
   * creation) and `idleTimeoutMs` (no stream activity) is required — a task
   * with neither is a load-time error.
   */
  | { kind: 'task'; deadlineMs?: number; idleTimeoutMs?: number; maxTurns?: number };

/** Bounds on one activation. Informational where the framework has no enforcement yet. */
export interface ActivationBounds {
  maxTurns?: number;
  maxMs?: number;
  maxInputTokens?: number;
}

/**
 * What ends this agent when the agent that spawned it ends.
 *
 * - `'end'` — attention tenancy: the agent exists to serve its parent and
 *   ends with it (a reader of held traffic, a subconscious).
 * - `'orphan'` — bounded task work: it may finish after the parent is gone.
 *   It is notified, offered for reparenting, and its result is held as
 *   attributed mail until someone can receive it.
 */
export type ParentEndPolicy = 'end' | 'orphan';

/** Where the completion of a bounded job goes. */
export interface ResultRoute {
  /** Recipient agent. */
  to: AgentName;
  /**
   * - `'message'`: an attributed message in the recipient's context, in the
   *   child's own name, plus a wake.
   * - `'tool-result'`: returned to the caller that is awaiting the run; the
   *   registry records the route but the caller delivers.
   */
  as: 'message' | 'tool-result';
}

/** Read access to another slot, merged into this agent's view. */
export interface ObserveEdge {
  /** The agent whose slot is read, when the slot belongs to one. */
  agent?: AgentName;
  /** Message-slot namespace; undefined = the shared un-namespaced slot. */
  slot?: string;
  /** Only messages at or after this sequence. */
  fromSequence?: number;
  /** Whether held (policy-diverted) traffic in that slot is visible. */
  includeHeld?: boolean;
}

/**
 * The four relationships, kept distinct even when one preset connects the
 * same pair through all of them. Spawning does not imply being the sole
 * observer; observing does not imply lifecycle authority.
 */
export interface AgentRelationships {
  /** Spawn: who created whom. Absent for an independent agent. */
  spawnedBy?: AgentName;
  /** Observe/read: whose streams or retained history this agent inspects. */
  observes: ObserveEdge[];
  /** Message: explicit communication paths this agent has used or was given. */
  messagePeers: AgentName[];
  /** Result route: where the completion of its bounded job returns. */
  resultTo?: ResultRoute;
}

/** How a derived agent's context relates to its parent's. */
export interface ContextInheritance {
  /** The agent whose context is inherited. */
  from: AgentName;
  /**
   * - `'copy'`: the parent's compiled context re-added as the child's own
   *   messages (the historical mechanism). The child can fold what it
   *   inherited but loses the parent's memory tree.
   * - `'shared'`: the child reads the parent's messages and fold state at
   *   the checkpoint through shared storage and writes only its own
   *   (requires store support; refused when unavailable).
   */
  mode: 'copy' | 'shared';
  /** The parent checkpoint (sequence on the parent's branch). Filled at creation. */
  atSequence?: number;
  /** The parent branch the checkpoint is on. Filled at creation. */
  branch?: string;
  /**
   * `'shared'` only: the Chronicle branch that holds everything the child
   * writes. It outlives the child and is what inspection or a later resume
   * opens. Filled at creation.
   */
  ownBranch?: string;
  /**
   * `'shared'` only: the context manager's own record of the derivation
   * (plain data). Kept so the child's context can be reopened after it
   * ended or after a restart — to resume it or to inspect it.
   */
  derivation?: unknown;
  /**
   * `'shared'` only: whether the parent's refusal ledger — what it declined
   * to compress, and why — comes along. Default false: a task fork is free
   * of its parent's refusals. A fork that stands in for the parent's
   * attention is created with it, so it is not asked the thing the parent
   * said no to without knowing. Named in the creation event either way.
   */
  refusals?: boolean;
  /**
   * - `'reuse'` (default): keep the parent's rendering frontier — prefix,
   *   cache markers and solver state — for fast startup.
   * - `'fresh'`: deliberately pay for a new solve, e.g. at another budget;
   *   presentation changes and the provider cache misses. An operating
   *   choice, not a failure.
   */
  solve?: 'reuse' | 'fresh';
}

/**
 * Declarative description of an agent. Inference configuration (model,
 * prompt, strategy, tools) stays in `AgentConfig`; this is everything the
 * registry and lifecycle need on top of it.
 */
export interface AgentSpec {
  name: AgentName;
  kind: AgentKind;
  /**
   * The model the agent runs on — "whose weights", next to `inherit.from`
   * for "whose context". Together they are what a consent decision about a
   * derived agent is made on. Filled by the framework from the agent's
   * configuration.
   */
  model?: string;
  roles: AgentRoles;
  lifetime: AgentLifetime;
  activation?: ActivationBounds;
  /** Applies when `spawnedBy` is set. Default `'orphan'`. */
  onParentEnd?: ParentEndPolicy;
  spawnedBy?: AgentName;
  observes?: ObserveEdge[];
  resultTo?: ResultRoute;
  inherit?: ContextInheritance;
  /**
   * Stored participants that render as this agent's own (assistant) turns
   * at request assembly. Stored authorship is never rewritten; this is a
   * model-facing role assignment only.
   */
  selfParticipants?: string[];
  /** The participant name its turns are presented under, when not its own name. */
  presentAs?: string;
  /** A channel this agent is bound to (its speech home and inbound scope). */
  homeChannel?: string;
  /**
   * Whether the agent reads the residents' shared un-namespaced message
   * slot (as its own slot or through an observe edge).
   */
  readsSharedSlot?: boolean;
  /** Chronicle namespace owning this agent's context. */
  namespace?: string;
  /** Free-form metadata surfaced in discovery. */
  metadata?: Record<string, unknown>;
}

/** Why an agent identity ended. */
export type AgentEndReason =
  | 'completed'
  | 'stopped'
  | 'deadline'
  | 'idle-ttl'
  | 'parent-ended'
  | 'host-restart'
  | 'not-configured'
  | 'failed'
  | (string & {});

/** Provenance stamp for anything one agent hands another. */
export interface AgentRef {
  agent: AgentName;
  /** Which instantiation of that identity. */
  incarnation: number;
}

/**
 * One bounded run. The owner is the agent whose in-flight work this is.
 * Derived from the framework's live turn state on request — never stored,
 * so it cannot disagree with what is actually running.
 */
export interface ActivationRecord {
  id: string;
  owner: AgentRef;
  /** When the triggering request was made (ms), when known. */
  requestedAt?: number;
  reason?: string;
  source?: string;
  /** The channel whose traffic started it, if any. */
  channelId?: string;
}

/** The registry's record of one agent. */
export interface AgentRecord {
  name: AgentName;
  kind: AgentKind;
  model?: string;
  /**
   * Bumped every time this identity is instantiated: a persistent agent
   * restored at boot is a new incarnation of the same identity.
   */
  incarnation: number;
  roles: AgentRoles;
  lifetime: AgentLifetime;
  activation?: ActivationBounds;
  onParentEnd: ParentEndPolicy;
  relationships: AgentRelationships;
  inherit?: ContextInheritance;
  selfParticipants?: string[];
  presentAs?: string;
  homeChannel?: string;
  readsSharedSlot: boolean;
  namespace?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Set when the identity has ended. Ended records stay inspectable. */
  ended?: { at: number; reason: AgentEndReason; by?: string };
  /**
   * Set while the agent's spawner is gone and nobody has adopted it. The
   * spawn edge is kept as history in `formerParent`.
   */
  orphaned?: {
    since: number;
    formerParent: AgentRef;
    reason: AgentEndReason;
    /** Agents offered as a new parent: nearest live ancestor first, then the primary. */
    candidates: AgentName[];
  };
}

/**
 * A result (or other attributed communication) that could not yet be handed
 * to its recipient. Held durably so a completed job is neither lost nor
 * delivered twice across a restart.
 */
export interface HeldMail {
  /** Stable id; stamped on the delivered message for de-duplication. */
  id: string;
  kind: 'result' | 'message' | 'notice';
  from: AgentRef;
  to: AgentName;
  /** Message content blocks, verbatim. */
  content: unknown[];
  /** Message ids / activation ids this was caused by. */
  causedBy?: string[];
  createdAt: number;
  /** Why it is still held. */
  heldBecause?: 'recipient-gone' | 'undelivered';
}

/**
 * Persisted shape of the registry (Chronicle snapshot state). Ended records
 * are history and live in a separate append-only log.
 */
export interface RegistrySnapshot {
  version: 1;
  /** Records of agents that have not ended. */
  records: AgentRecord[];
  /** Highest incarnation issued, for names that can still be referred to. */
  incarnations: Record<AgentName, number>;
  mail: HeldMail[];
}

/** Outcome of ending an agent: who was affected. */
export interface EndOutcome {
  ended: AgentRecord;
  /** Children that ended with it (attention tenancy), deepest first. */
  cascaded: AgentRecord[];
  /** Children now orphaned, with the candidates offered as new parents. */
  orphaned: Array<{ record: AgentRecord; candidates: AgentName[] }>;
}

/**
 * A policy interval in force (a tune-out hold, a focus). Read from the
 * owning coordinator's durable state — the registry never mirrors it.
 * Ending an epoch ends neither an agent nor a task.
 */
export interface PolicyEpoch {
  id: string;
  kind: 'tune-out' | (string & {});
  /** What the policy applies to. */
  scope: { serverId: string; channelId: string };
  /** The agent whose attention the policy governs. */
  owner?: AgentName;
  /** The agent reading what the policy withholds, if any. */
  reader?: AgentName;
  startedAtSequence?: number;
  expiresAtMs?: number;
}
