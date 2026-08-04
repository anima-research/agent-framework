/**
 * EventGate — file-driven inference gating with per-policy debounce.
 *
 * Reads policies from a `gate.json` config file. Policies are evaluated in
 * order — first match wins. Each policy specifies a behavior: "always"
 * (trigger immediately), "skip" (don't trigger), or { debounce: ms }
 * (batch events per-policy, deliver when timer fires).
 *
 * The gate controls inference triggering only. Events always enter context
 * and are always dispatched to modules — the gate decides whether to spend
 * inference tokens, not whether the agent should know about the event.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GateScript } from './gate-script.js';

import type { ToolDefinition } from '../types/events.js';
import type {
  GateConfig,
  GatePolicy,
  GatePolicyMatch,
  GateBehavior,
  GateDecision,
  GateEventInfo,
  GatePolicyStats,
  GateStatus,
} from './types.js';

// Re-export types consumers need
export type { GateConfig, GateOptions, GateDecision, GateEventInfo } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max content length stored in pending debounce events. */
const MAX_CONTENT_SNIPPET = 200;
/** Max content length shown in onWake trace summaries. */
const MAX_TRACE_SNIPPET = 80;
/** Max events buffered during inference before oldest are dropped. */
const MAX_INFERENCE_BUFFER = 100;
/** Minimum interval between filesystem checks for config changes (ms). */
const RELOAD_THROTTLE_MS = 1000;
/** Minimum debounce value (ms). */
const MIN_DEBOUNCE_MS = 100;
/** Maximum debounce value (ms). */
const MAX_DEBOUNCE_MS = 300_000;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: GateConfig = {
  policies: [],
  default: 'always',
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingEvent {
  policyName: string;
  content: string;
  eventType: string;
  timestamp: number;
  /** The framework stores MCPL event content in the context window AT ARRIVAL
   *  (channel-incoming and push-event both addMessage before the gate decides
   *  anything). For those, the debounced wake must NOT re-quote the content —
   *  a [Gate:] copy delivered minutes later reads as a fresh, stale duplicate
   *  of a message the agent may have long since handled. */
  inContext: boolean;
  channelId?: string;
  /** Human-readable channel name (e.g. Discord channel name) when the event's
   *  metadata carries one — batched-wake lines render this instead of the raw
   *  composite channel id. */
  channelLabel?: string;
}

interface DebounceState {
  timer: ReturnType<typeof setTimeout>;
  events: PendingEvent[];
}

/** Token bucket for one (policy, key) pair under a rate_limit behavior. */
interface RateBucket {
  /** Tokens currently available. */
  tokens: number;
  /** Last epoch-ms timestamp the bucket was refilled. */
  lastRefill: number;
}

/** Synthetic key used when a policy has no `keyBy` or the field is missing. */
const SHARED_BUCKET_KEY = '__shared__';

interface CompiledPolicy {
  policy: GatePolicy;
  filterRegex?: RegExp;
  sourceRegex?: RegExp;
  channelRegex?: RegExp;
  mountRegex?: RegExp;
  pathRegex?: RegExp;
  tagsAnyRe?: RegExp[];
  tagsAllRe?: RegExp[];
  tagsNoneRe?: RegExp[];
}

interface PolicyStats {
  matchCount: number;
  lastMatchTimestamp: number | null;
}

// ---------------------------------------------------------------------------
// Trace event shape (subset — avoids importing the full TraceEvent union)
// ---------------------------------------------------------------------------

interface TraceEventLike {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Glob matching (simple * wildcards)
// ---------------------------------------------------------------------------

function compileGlob(pattern: string): RegExp {
  // Escape everything except *, then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (!pattern.includes('*')) {
    return new RegExp('^' + escaped + '$');
  }
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/**
 * Truthiness for `metadataTrue` matching. Stricter than JS `Boolean(x)`:
 * empty strings, empty arrays, and empty objects all count as false, so
 * `metadataTrue: ["mentionIds"]` doesn't match every event that happens
 * to carry an empty `mentionIds: []` array.
 */
function isMetadataTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Compact, log-friendly serialization of a GateBehavior. */
function formatBehavior(b: import('./types.js').GateBehavior): string {
  if (typeof b === 'string') return b;
  if ('debounce' in b) return `debounce:${b.debounce}`;
  if ('rate_limit' in b) {
    const k = b.rate_limit.keyBy ? `,keyBy:${b.rate_limit.keyBy}` : '';
    return `rate_limit:${b.rate_limit.tokens}/${b.rate_limit.refillIntervalMs}ms${k}`;
  }
  if ('passive_sample' in b) {
    const k = b.passive_sample.keyBy ? `,keyBy:${b.passive_sample.keyBy}` : '';
    return `passive_sample:${b.passive_sample.every}${k}`;
  }
  return 'unknown';
}

/**
 * Stable fingerprint for a GateBehavior, used during reload to detect
 * config changes that invalidate per-policy state. JSON.stringify is
 * deterministic for our small, flat behavior shapes — keys appear in
 * declaration order — so this is enough to spot any change in tokens,
 * refillIntervalMs, keyBy, every, or debounce duration.
 */
function behaviorFingerprint(b: import('./types.js').GateBehavior): string {
  return typeof b === 'string' ? b : JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig(raw: unknown): GateConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gate.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  const defaultBehavior = obj.default ?? 'always';
  if (defaultBehavior !== 'always' && defaultBehavior !== 'defer' && defaultBehavior !== 'skip') {
    throw new Error(`gate.json "default" must be "always", "defer", or "skip", got: ${defaultBehavior}`);
  }

  const policies: GatePolicy[] = [];
  if (Array.isArray(obj.policies)) {
    for (const p of obj.policies) {
      policies.push(validatePolicy(p));
    }
  }

  return { policies, default: defaultBehavior };
}

function validatePolicy(raw: unknown): GatePolicy {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Each gate policy must be an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Gate policy must have a "name" string');
  }

  // Validate behavior
  let behavior: GateBehavior;
  if (obj.behavior === 'always' || obj.behavior === 'defer' || obj.behavior === 'skip') {
    behavior = obj.behavior;
  } else if (obj.behavior && typeof obj.behavior === 'object') {
    const b = obj.behavior as Record<string, unknown>;
    if ('debounce' in b) {
      if (typeof b.debounce !== 'number' || b.debounce <= 0) {
        throw new Error(`Policy "${obj.name}": debounce must be a positive number`);
      }
      if (b.debounce < MIN_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be >= ${MIN_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      if (b.debounce > MAX_DEBOUNCE_MS) {
        throw new Error(`Policy "${obj.name}": debounce must be <= ${MAX_DEBOUNCE_MS}ms, got ${b.debounce}`);
      }
      behavior = { debounce: b.debounce };
    } else if ('rate_limit' in b) {
      const rl = b.rate_limit;
      if (!rl || typeof rl !== 'object') {
        throw new Error(`Policy "${obj.name}": rate_limit must be an object`);
      }
      const conf = rl as Record<string, unknown>;
      if (typeof conf.tokens !== 'number' || !Number.isFinite(conf.tokens) || conf.tokens <= 0) {
        throw new Error(`Policy "${obj.name}": rate_limit.tokens must be a positive number`);
      }
      if (typeof conf.refillIntervalMs !== 'number' || !Number.isFinite(conf.refillIntervalMs) || conf.refillIntervalMs <= 0) {
        throw new Error(`Policy "${obj.name}": rate_limit.refillIntervalMs must be a positive number`);
      }
      const out: { tokens: number; refillIntervalMs: number; keyBy?: string } = {
        tokens: conf.tokens,
        refillIntervalMs: conf.refillIntervalMs,
      };
      if (typeof conf.keyBy === 'string' && conf.keyBy.length > 0) {
        out.keyBy = conf.keyBy;
      }
      behavior = { rate_limit: out };
    } else if ('passive_sample' in b) {
      const ps = b.passive_sample;
      if (!ps || typeof ps !== 'object') {
        throw new Error(`Policy "${obj.name}": passive_sample must be an object`);
      }
      const conf = ps as Record<string, unknown>;
      if (typeof conf.every !== 'number' || !Number.isInteger(conf.every) || conf.every <= 0) {
        throw new Error(`Policy "${obj.name}": passive_sample.every must be a positive integer`);
      }
      const out: { every: number; keyBy?: string } = { every: conf.every };
      if (typeof conf.keyBy === 'string' && conf.keyBy.length > 0) {
        out.keyBy = conf.keyBy;
      }
      behavior = { passive_sample: out };
    } else {
      throw new Error(`Policy "${obj.name}": unknown behavior — expected always | defer | skip | { debounce } | { rate_limit } | { passive_sample }`);
    }
  } else {
    behavior = 'always';
  }

  // Validate match (lenient — missing fields mean "match all")
  const match: GatePolicyMatch = {};
  if (obj.match && typeof obj.match === 'object') {
    const m = obj.match as Record<string, unknown>;
    if (Array.isArray(m.scope)) match.scope = m.scope.filter(s => typeof s === 'string');
    if (typeof m.source === 'string') match.source = m.source;
    if (typeof m.channel === 'string') match.channel = m.channel;
    if (typeof m.mount === 'string') match.mount = m.mount;
    if (typeof m.pathGlob === 'string') match.pathGlob = m.pathGlob;
    if (Array.isArray(m.metadataTrue)) {
      const fields = m.metadataTrue.filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (fields.length > 0) match.metadataTrue = fields;
    }
    const tagList = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
      return out.length > 0 ? out : undefined;
    };
    const tagsAny = tagList(m.tagsAny); if (tagsAny) match.tagsAny = tagsAny;
    const tagsAll = tagList(m.tagsAll); if (tagsAll) match.tagsAll = tagsAll;
    const tagsNone = tagList(m.tagsNone); if (tagsNone) match.tagsNone = tagsNone;
    if (m.filter && typeof m.filter === 'object') {
      const f = m.filter as Record<string, unknown>;
      if ((f.type === 'text' || f.type === 'regex') && typeof f.pattern === 'string') {
        match.filter = { type: f.type, pattern: f.pattern };
        if (f.type === 'regex') {
          try { new RegExp(f.pattern as string); } catch (e) {
            throw new Error(`Policy "${obj.name}": invalid regex pattern: ${e}`);
          }
        }
      }
    }
  }

  // Validate resets (optional list of policy names; unknown names are ignored
  // at runtime so reload races don't blow up).
  let resets: string[] | undefined;
  if (Array.isArray(obj.resets)) {
    const names = obj.resets.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (names.length > 0) resets = names;
  }

  const policy: GatePolicy = { name: obj.name, match, behavior };
  if (resets) policy.resets = resets;
  return policy;
}

// ---------------------------------------------------------------------------
// EventGate
// ---------------------------------------------------------------------------

export class EventGate {
  private configPath: string;
  private config: GateConfig;
  /** Optional agent-authored programmable gate (gate.js). */
  private gateScript: GateScript;
  private compiledPolicies: CompiledPolicy[] = [];
  private configMtime: number = 0;
  private lastReloadCheck: number = 0;
  private configSource: 'file' | 'initial' | 'default' = 'default';
  private lastReloadTimestamp: number | null = null;
  private configErrors: string[] = [];

  // Debounce state
  private debounceTimers = new Map<string, DebounceState>();

  // Rate-limit state — policy name → key → bucket.
  private rateLimitBuckets = new Map<string, Map<string, RateBucket>>();
  // Passive-sample state — policy name → key → counter (count since last fire).
  private passiveSampleCounters = new Map<string, Map<string, number>>();
  // Per-policy denial / fire counters for status reporting.
  private rateLimitDenied = new Map<string, number>();
  private passiveSampleFires = new Map<string, number>();

  // Inference buffering
  private inferring = new Set<string>();
  private inferenceBuffer: PendingEvent[] = [];

  // Per-policy stats
  private stats = new Map<string, PolicyStats>();

  // Observability counters for events that didn't match any policy
  private totalEvaluations = 0;
  private defaultTriggered = 0;
  private defaultSkipped = 0;
  private defaultByEventType = new Map<string, { triggered: number; skipped: number }>();

  // Sleep state (set via the `sleep` tool). evaluate() suppresses non-privileged
  // wakes while now() < sleepUntil. A self-wake timer (sleepTimer) fires an
  // inference when the window expires, so `sleep(N)` means "wake me in N
  // seconds" rather than merely lifting suppression and waiting for an external
  // event.
  private sleepUntil = 0;
  private sleepNote: string | undefined;
  private sleepSuppressed = 0;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepAgent: string | undefined;

  // Self-wake timers per agent (skip_reply's wake_in_seconds). Unlike sleep,
  // a self-wake suppresses NOTHING — it means "if nothing else wakes me by
  // then, wake me". Any turn start for the agent cancels its pending
  // self-wake (an external wake supersedes it; the timer would otherwise
  // land as a redundant empty wake right after the turn).
  private selfWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Privileged users who may wake the agent through sleep. Hot-reloaded from
  // privilegedUsersPath on change.
  private privilegedUsersPath: string | undefined;
  private privilegedUserIds = new Set<string>();
  private privilegedMtime = 0;
  private lastPrivilegedCheck = 0;

  // Dependency-injected callbacks
  private emitTrace: (event: TraceEventLike) => void;
  private addMessageFn: (participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>) => unknown;
  private requestInferenceFn: (agentName: string, reason: string, source: string) => void;
  private getAgentNamesFn: () => string[];
  /** Clock injection — keeps the new rate_limit / passive_sample paths
   *  testable without monkey-patching Date.now globally. */
  private now: () => number;

  constructor(opts: {
    configPath: string;
    initialConfig?: GateConfig;
    privilegedUsersPath?: string;
    emitTrace: (event: TraceEventLike) => void;
    addMessage: (participant: string, content: Array<{ type: 'text'; text: string }>, metadata?: Record<string, unknown>) => unknown;
    requestInference: (agentName: string, reason: string, source: string) => void;
    getAgentNames: () => string[];
    /** Optional clock — defaults to Date.now. Tests inject for deterministic time. */
    now?: () => number;
    /** Per-event timeout (ms) for the optional gate.js script. Default 50. */
    scriptTimeoutMs?: number;
  }) {
    this.configPath = opts.configPath;
    this.privilegedUsersPath = opts.privilegedUsersPath;
    this.emitTrace = opts.emitTrace;
    this.addMessageFn = opts.addMessage;
    this.requestInferenceFn = opts.requestInference;
    this.getAgentNamesFn = opts.getAgentNames;
    this.now = opts.now ?? (() => Date.now());
    this.loadPrivileged();

    // Seed or reconcile the on-disk config.
    //
    // First start: write `initialConfig` verbatim.
    // Subsequent starts: if the recipe/config source declares policies that
    // aren't yet in gate.json (e.g. the user edited the recipe between
    // sessions), append them by name. Existing policies are left alone so
    // user edits via `workspace--edit _config/gate.json` survive.
    // The `default` field is not reconciled — it's an explicit operator
    // choice and a recipe change shouldn't silently flip live wake
    // behavior for a session that's already been running.
    if (opts.initialConfig) {
      try {
        mkdirSync(dirname(this.configPath), { recursive: true });
        if (!existsSync(this.configPath)) {
          writeFileSync(this.configPath, JSON.stringify(opts.initialConfig, null, 2) + '\n');
        } else {
          const existing = this.loadConfig();
          if (existing) {
            const existingNames = new Set(existing.policies.map(p => p.name));
            const missing = opts.initialConfig.policies.filter(p => !existingNames.has(p.name));
            if (missing.length > 0) {
              const reconciled: GateConfig = {
                ...existing,
                policies: [...existing.policies, ...missing],
              };
              writeFileSync(this.configPath, JSON.stringify(reconciled, null, 2) + '\n');
              opts.emitTrace({
                type: 'gate:config-reconciled',
                configPath: this.configPath,
                addedPolicies: missing.map(p => p.name),
                timestamp: Date.now(),
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.configErrors.push(`Failed to seed/reconcile gate.json: ${msg}`);
      }
    }

    // Load config
    this.config = this.loadConfig() ?? opts.initialConfig ?? { ...DEFAULT_CONFIG };
    this.compiledPolicies = this.compilePolicies(this.config);

    // Programmable gate: an optional agent-authored `gate.js` next to gate.json.
    // Absent ⇒ inactive (zero overhead beyond a throttled stat check).
    this.gateScript = new GateScript(
      join(dirname(this.configPath), 'gate.js'),
      opts.scriptTimeoutMs ?? 50,
      this.now,
    );
  }

  // =========================================================================
  // Config loading
  // =========================================================================

  private loadConfig(): GateConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const stat = statSync(this.configPath);
      this.configMtime = stat.mtimeMs;
      const config = validateConfig(JSON.parse(raw));
      this.configSource = 'file';
      this.configErrors = [];
      return config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.configErrors = [msg];
      this.emitTrace({
        type: 'gate:config-error',
        error: msg,
        configPath: this.configPath,
        timestamp: Date.now(),
      });
      return null; // Caller keeps previous config
    }
  }

  private compilePolicies(config: GateConfig): CompiledPolicy[] {
    return config.policies.map(policy => {
      const compiled: CompiledPolicy = { policy };
      if (policy.match.filter?.type === 'regex') {
        try { compiled.filterRegex = new RegExp(policy.match.filter.pattern, 'i'); } catch { /* skip */ }
      }
      if (policy.match.source) {
        compiled.sourceRegex = compileGlob(policy.match.source);
      }
      if (policy.match.channel) {
        compiled.channelRegex = compileGlob(policy.match.channel);
      }
      if (policy.match.mount) {
        compiled.mountRegex = compileGlob(policy.match.mount);
      }
      if (policy.match.pathGlob) {
        compiled.pathRegex = compileGlob(policy.match.pathGlob);
      }
      if (policy.match.tagsAny) compiled.tagsAnyRe = policy.match.tagsAny.map(compileGlob);
      if (policy.match.tagsAll) compiled.tagsAllRe = policy.match.tagsAll.map(compileGlob);
      if (policy.match.tagsNone) compiled.tagsNoneRe = policy.match.tagsNone.map(compileGlob);
      return compiled;
    });
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.lastReloadCheck < RELOAD_THROTTLE_MS) return;
    this.lastReloadCheck = now;

    try {
      if (!existsSync(this.configPath)) return;
      const stat = statSync(this.configPath);
      if (stat.mtimeMs === this.configMtime) return;

      const newConfig = this.loadConfig();
      if (!newConfig) return; // Parse error — keep previous config

      // Capture old policies' behavior fingerprints before any state
      // mutation — needed to detect kept policies whose parameters changed.
      const oldBehaviorByName = new Map<string, string>();
      for (const p of this.config.policies) {
        oldBehaviorByName.set(p.name, behaviorFingerprint(p.behavior));
      }

      // Clean up state for REMOVED policies (gone from new config entirely).
      const newPolicyNames = new Set(newConfig.policies.map(p => p.name));
      const removedPolicies: string[] = [];
      for (const oldName of oldBehaviorByName.keys()) {
        if (!newPolicyNames.has(oldName)) {
          this.clearPolicyState(oldName, { deliverPendingDebounce: true });
          this.stats.delete(oldName);
          removedPolicies.push(oldName);
        }
      }

      // Clean up state for KEPT policies whose behavior parameters changed.
      // Without this, a tokens 100→5 edit (or keyBy switch, or every 10→3,
      // etc.) wouldn't take effect until existing buckets/counters drained.
      // Stats are preserved — matchCount is historical, not live state.
      const stateClearedPolicies: string[] = [];
      for (const newPolicy of newConfig.policies) {
        const oldHash = oldBehaviorByName.get(newPolicy.name);
        if (oldHash === undefined) continue; // new policy, no state to clear
        const newHash = behaviorFingerprint(newPolicy.behavior);
        if (oldHash !== newHash) {
          this.clearPolicyState(newPolicy.name, { deliverPendingDebounce: true });
          stateClearedPolicies.push(newPolicy.name);
        }
      }

      this.config = newConfig;
      this.compiledPolicies = this.compilePolicies(newConfig);
      this.lastReloadTimestamp = now;

      this.emitTrace({
        type: 'gate:config-reloaded',
        configPath: this.configPath,
        policyCount: newConfig.policies.length,
        removedPolicies: removedPolicies.length > 0 ? removedPolicies : undefined,
        stateClearedPolicies:
          stateClearedPolicies.length > 0 ? stateClearedPolicies : undefined,
        timestamp: now,
      });
    } catch {
      // Ignore stat errors
    }
  }

  // =========================================================================
  // Runtime policy mutation (backs wake_add_rule / wake_remove_rule)
  // =========================================================================

  /**
   * Add or replace (upsert) a single policy in gate.json and apply it live.
   *
   * The raw policy is validated with the SAME `validatePolicy` used when loading
   * gate.json — an invalid shape throws (nothing is written) and the caller
   * surfaces it as a tool error. On success the policy is persisted to gate.json
   * (so it survives restart and is visible to `workspace--edit _config/gate.json`)
   * and the in-memory config is swapped in immediately, so the rule takes effect
   * without waiting for the throttled mtime reload.
   *
   * The freshest on-disk config is re-read first, so a concurrent operator edit
   * isn't clobbered. A policy with the same `name` is replaced IN PLACE (order
   * preserved); otherwise it is appended, or prepended when `position:'prepend'`
   * — first match wins, so a wake rule that must beat a broad defer/debounce
   * belongs at the front.
   */
  addPolicy(rawPolicy: unknown, options?: { position?: 'append' | 'prepend' }): GatePolicy {
    const policy = validatePolicy(rawPolicy);
    const current = this.loadConfig() ?? this.config;
    const policies = [...current.policies];
    const idx = policies.findIndex((p) => p.name === policy.name);
    if (idx >= 0) {
      policies[idx] = policy;
    } else if (options?.position === 'prepend') {
      policies.unshift(policy);
    } else {
      policies.push(policy);
    }
    this.writeConfig({ ...current, policies });
    this.emitTrace({
      type: 'gate:policy-added',
      configPath: this.configPath,
      policyName: policy.name,
      replaced: idx >= 0,
      timestamp: Date.now(),
    });
    return policy;
  }

  /**
   * Remove a policy by name from gate.json and clear its live state. Any pending
   * debounce batch is delivered first (matching reloadIfChanged's removal path,
   * so buffered events aren't silently dropped). Returns false if no policy of
   * that name exists (nothing written). Freshest on-disk config is re-read first
   * (see addPolicy).
   */
  removePolicy(name: string): boolean {
    const current = this.loadConfig() ?? this.config;
    if (!current.policies.some((p) => p.name === name)) {
      return false;
    }
    // Deliver any pending debounce batch, then drop timers/buckets/counters.
    this.clearPolicyState(name, { deliverPendingDebounce: true });
    this.stats.delete(name);
    const policies = current.policies.filter((p) => p.name !== name);
    this.writeConfig({ ...current, policies });
    this.emitTrace({
      type: 'gate:policy-removed',
      configPath: this.configPath,
      policyName: name,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * List the current policy names (freshest on-disk view). Cheap helper for
   * tools/UX that want to show what's active without the full status payload.
   */
  listPolicyNames(): string[] {
    const current = this.loadConfig() ?? this.config;
    return current.policies.map((p) => p.name);
  }

  /**
   * Persist a config to gate.json and apply it in memory together: write the
   * file, swap in the compiled policies, and sync `configMtime` to the new file
   * so `reloadIfChanged` doesn't redundantly re-parse identical content. Throws
   * if the write fails (disk/permission) — callers surface it as a tool error.
   */
  private writeConfig(config: GateConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n');
    this.config = config;
    this.compiledPolicies = this.compilePolicies(config);
    this.configSource = 'file';
    this.configErrors = [];
    this.lastReloadTimestamp = Date.now();
    try {
      this.configMtime = statSync(this.configPath).mtimeMs;
    } catch {
      // A failed stat only risks one redundant reload; keep the old mtime.
    }
  }

  // =========================================================================
  // Policy matching — first match wins
  // =========================================================================

  private matchPolicy(info: GateEventInfo): GatePolicy | null {
    for (const compiled of this.compiledPolicies) {
      if (this.compiledMatches(compiled, info)) {
        return compiled.policy;
      }
    }
    return null;
  }

  private compiledMatches(compiled: CompiledPolicy, info: GateEventInfo): boolean {
    const match = compiled.policy.match;

    // Scope check
    if (match.scope && match.scope.length > 0 && !match.scope.includes(info.eventType)) {
      return false;
    }

    // Source check (serverId)
    if (compiled.sourceRegex && !compiled.sourceRegex.test(info.serverId)) {
      return false;
    }

    // Channel check
    if (compiled.channelRegex && !compiled.channelRegex.test(info.channelId)) {
      return false;
    }

    // Mount check (workspace fs events)
    if (compiled.mountRegex) {
      if (!info.mount || !compiled.mountRegex.test(info.mount)) {
        return false;
      }
    }

    // Path glob check — matches if ANY path matches
    if (compiled.pathRegex) {
      const paths = info.paths;
      if (!paths || paths.length === 0) return false;
      const anyMatch = paths.some(p => compiled.pathRegex!.test(p));
      if (!anyMatch) return false;
    }

    // Content filter check
    if (match.filter) {
      if (match.filter.type === 'text') {
        if (!info.content.toLowerCase().includes(match.filter.pattern.toLowerCase())) {
          return false;
        }
      } else if (compiled.filterRegex) {
        if (!compiled.filterRegex.test(info.content)) {
          return false;
        }
      } else {
        return false; // Regex failed to compile
      }
    }

    // Metadata-truthy check — match if ANY listed field is truthy.
    // Uses isMetadataTruthy so empty arrays / strings / objects are treated
    // as falsy (matches user expectation, not raw JS Boolean coercion).
    if (match.metadataTrue && match.metadataTrue.length > 0) {
      const md = info.metadata ?? {};
      const anyTrue = match.metadataTrue.some(field => isMetadataTruthy(md[field]));
      if (!anyTrue) return false;
    }

    // Tag matching (MCPL RFC-001). Patterns are globs; `tags` is the event's
    // (implication-expanded) tag set. A pattern "matches" if it matches ANY tag.
    if (compiled.tagsAnyRe || compiled.tagsAllRe || compiled.tagsNoneRe) {
      const tags = info.tags ?? [];
      const patternHits = (re: RegExp): boolean => tags.some(t => re.test(t));
      if (compiled.tagsAnyRe && !compiled.tagsAnyRe.some(patternHits)) return false;
      if (compiled.tagsAllRe && !compiled.tagsAllRe.every(patternHits)) return false;
      if (compiled.tagsNoneRe && compiled.tagsNoneRe.some(patternHits)) return false;
    }

    return true;
  }

  // =========================================================================
  // Evaluate — main entry point
  // =========================================================================

  evaluate(info: GateEventInfo): GateDecision {
    this.reloadIfChanged();

    // Sleep suppression: while asleep, drop EXTERNAL wakes. Two things still
    // rouse the agent — its own heartbeat (an internal clock, not an outside
    // interruption: each tick lets the agent reconsider and optionally `wake`)
    // and a privileged user's ping. The event always enters context regardless
    // (the gate only governs inference triggering).
    if (this.sleepUntil > this.now()) {
      this.reloadPrivilegedIfChanged();
      const isHeartbeat =
        info.metadata?.source === 'heartbeat' || info.serverId === 'heartbeat';
      const authorId = this.extractAuthorId(info.metadata);
      const privileged = authorId !== null && this.privilegedUserIds.has(authorId);
      if (!isHeartbeat && !privileged) {
        this.sleepSuppressed++;
        this.totalEvaluations++;
        this.emitTrace({
          type: 'gate:decision',
          eventType: info.eventType,
          serverId: info.serverId || undefined,
          channelId: info.channelId || undefined,
          matchedPolicy: 'asleep',
          trigger: false,
          behavior: 'skip',
          timestamp: this.now(),
        });
        return { trigger: false, policyName: 'asleep', behavior: 'skip' };
      }
      // Privileged author — fall through to normal policy evaluation.
    }

    // Programmable gate (gate.js) takes precedence when present and returns a
    // behavior; null/undefined (inactive, error, or a deliberate pass) falls
    // through to the declarative gate.json policies below.
    const scripted = this.gateScript.evaluate(info);
    const policy: GatePolicy | null =
      scripted != null ? { name: 'gate.js', match: {}, behavior: scripted } : this.matchPolicy(info);
    const decision = this.computeDecision(policy, info);

    this.totalEvaluations++;
    if (!policy) {
      const bucket = this.defaultByEventType.get(info.eventType)
        ?? { triggered: 0, skipped: 0 };
      if (decision.trigger) {
        this.defaultTriggered++;
        bucket.triggered++;
      } else {
        this.defaultSkipped++;
        bucket.skipped++;
      }
      this.defaultByEventType.set(info.eventType, bucket);
    }

    this.emitTrace({
      type: 'gate:decision',
      eventType: info.eventType,
      serverId: info.serverId || undefined,
      channelId: info.channelId || undefined,
      matchedPolicy: decision.policyName,
      trigger: decision.trigger,
      behavior: formatBehavior(decision.behavior),
      timestamp: this.now(),
    });

    return decision;
  }

  private computeDecision(policy: GatePolicy | null, info: GateEventInfo): GateDecision {
    if (!policy) {
      const trigger = (this.config.default ?? 'always') === 'always';
      return { trigger, policyName: null, behavior: this.config.default ?? 'always' };
    }

    // Record stats
    const policyStats = this.stats.get(policy.name) ?? { matchCount: 0, lastMatchTimestamp: null };
    policyStats.matchCount++;
    policyStats.lastMatchTimestamp = this.now();
    this.stats.set(policy.name, policyStats);

    // Legacy trace kept for backward compatibility with existing consumers.
    this.emitTrace({
      type: 'gate:policy-matched',
      policyName: policy.name,
      behavior: formatBehavior(policy.behavior),
      eventType: info.eventType,
      source: info.serverId || undefined,
      timestamp: this.now(),
    });

    if (policy.behavior === 'defer' || policy.behavior === 'skip') {
      // Report the configured name faithfully ('defer' or legacy 'skip').
      return { trigger: false, policyName: policy.name, behavior: policy.behavior };
    }

    if (policy.behavior === 'always') {
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: 'always' };
    }

    if (typeof policy.behavior === 'object') {
      if ('debounce' in policy.behavior) {
        this.handleDebounce(policy, info);
        return { trigger: false, policyName: policy.name, behavior: policy.behavior };
      }
      if ('rate_limit' in policy.behavior) {
        return this.applyRateLimit(policy, info, policy.behavior.rate_limit);
      }
      if ('passive_sample' in policy.behavior) {
        return this.applyPassiveSample(policy, info, policy.behavior.passive_sample);
      }
    }

    // Unknown behavior shape — should be unreachable thanks to validation,
    // but be defensive: treat as skip rather than crash on a bad config.
    return { trigger: false, policyName: policy.name, behavior: 'skip' };
  }

  // =========================================================================
  // rate_limit + passive_sample + resets
  // =========================================================================

  /** Resolve the partition key for keyBy-style behaviors. */
  private resolveKey(metadata: Record<string, unknown> | undefined, keyBy: string | undefined): string {
    if (!keyBy) return SHARED_BUCKET_KEY;
    const value = metadata?.[keyBy];
    if (value === undefined || value === null || value === '') return SHARED_BUCKET_KEY;
    return String(value);
  }

  private applyRateLimit(
    policy: GatePolicy,
    info: GateEventInfo,
    config: { tokens: number; refillIntervalMs: number; keyBy?: string },
  ): GateDecision {
    const key = this.resolveKey(info.metadata, config.keyBy);
    let buckets = this.rateLimitBuckets.get(policy.name);
    if (!buckets) {
      buckets = new Map();
      this.rateLimitBuckets.set(policy.name, buckets);
    }

    const now = this.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.tokens, lastRefill: now };
      buckets.set(key, bucket);
    } else if (bucket.tokens < config.tokens) {
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        const tokensToAdd = Math.floor(elapsed / config.refillIntervalMs);
        if (tokensToAdd > 0) {
          bucket.tokens = Math.min(config.tokens, bucket.tokens + tokensToAdd);
          bucket.lastRefill += tokensToAdd * config.refillIntervalMs;
        }
      }
    } else {
      // Bucket already full — keep the refill clock fresh so the next
      // drain starts from "now" rather than ancient history.
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: policy.behavior };
    }

    this.rateLimitDenied.set(policy.name, (this.rateLimitDenied.get(policy.name) ?? 0) + 1);
    return { trigger: false, policyName: policy.name, behavior: policy.behavior };
  }

  private applyPassiveSample(
    policy: GatePolicy,
    info: GateEventInfo,
    config: { every: number; keyBy?: string },
  ): GateDecision {
    const key = this.resolveKey(info.metadata, config.keyBy);
    let counters = this.passiveSampleCounters.get(policy.name);
    if (!counters) {
      counters = new Map();
      this.passiveSampleCounters.set(policy.name, counters);
    }

    const next = (counters.get(key) ?? 0) + 1;
    if (next >= config.every) {
      counters.set(key, 0);
      this.passiveSampleFires.set(policy.name, (this.passiveSampleFires.get(policy.name) ?? 0) + 1);
      this.applyResets(policy);
      return { trigger: true, policyName: policy.name, behavior: policy.behavior };
    }
    counters.set(key, next);
    return { trigger: false, policyName: policy.name, behavior: policy.behavior };
  }

  /**
   * Clear bucket / counter state for the policies named in `policy.resets`.
   * Called when a policy fires (decision.trigger === true). Unknown names
   * are silently ignored — gate.json reload could remove them.
   */
  private applyResets(policy: GatePolicy): void {
    if (!policy.resets || policy.resets.length === 0) return;
    for (const target of policy.resets) {
      this.rateLimitBuckets.delete(target);
      this.passiveSampleCounters.delete(target);
    }
  }

  /**
   * Clear ALL per-policy state (debounce timer, rate-limit buckets,
   * passive-sample counters, denial / fire counters) for one policy.
   * Used by reloadIfChanged when a policy is removed or its behavior
   * params change. Stats (matchCount, lastMatchTimestamp) are preserved
   * — those are historical and shouldn't reset on a config edit.
   */
  private clearPolicyState(
    name: string,
    options: { deliverPendingDebounce: boolean },
  ): void {
    const debounce = this.debounceTimers.get(name);
    if (debounce) {
      clearTimeout(debounce.timer);
      if (options.deliverPendingDebounce && debounce.events.length > 0) {
        this.deliverEvents(debounce.events);
      }
      this.debounceTimers.delete(name);
    }
    this.rateLimitBuckets.delete(name);
    this.passiveSampleCounters.delete(name);
    this.rateLimitDenied.delete(name);
    this.passiveSampleFires.delete(name);
  }

  // =========================================================================
  // shouldTriggerInference callback adapter
  // =========================================================================

  /**
   * Returns a callback compatible with McplServerConfig.shouldTriggerInference.
   * Used by the framework to wire the gate into PushHandler and ChannelRegistry.
   */
  asShouldTriggerCallback(): (content: string, metadata: Record<string, unknown>) => boolean {
    return (content: string, metadata: Record<string, unknown>): boolean => {
      const decision = this.evaluate({
        content,
        eventType: (metadata.eventType as string) ?? 'unknown',
        serverId: (metadata.serverId as string) ?? '',
        channelId: (metadata.channelId as string) ?? '',
        metadata,
        tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : undefined,
      });
      return decision.trigger;
    };
  }

  // =========================================================================
  // Debounce
  // =========================================================================

  private handleDebounce(policy: GatePolicy, info: GateEventInfo): void {
    const debounceMs = (policy.behavior as { debounce: number }).debounce;

    const event: PendingEvent = {
      policyName: policy.name,
      content: info.content.length > MAX_CONTENT_SNIPPET
        ? info.content.slice(0, MAX_CONTENT_SNIPPET) + '...'
        : info.content,
      eventType: info.eventType,
      timestamp: Date.now(),
      inContext: info.eventType === 'mcpl:channel-incoming' || info.eventType === 'mcpl:push-event',
      channelId: info.channelId || undefined,
      channelLabel:
        typeof info.metadata?.channelName === 'string' && info.metadata.channelName
          ? (info.metadata.channelName as string)
          : undefined,
    };

    const existing = this.debounceTimers.get(policy.name);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push(event);
      existing.timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
    } else {
      const timer = setTimeout(() => this.fireDebounce(policy.name), debounceMs);
      this.debounceTimers.set(policy.name, { timer, events: [event] });
    }
  }

  private fireDebounce(policyName: string): void {
    const state = this.debounceTimers.get(policyName);
    if (!state || state.events.length === 0) {
      this.debounceTimers.delete(policyName);
      return;
    }

    const events = state.events;
    this.debounceTimers.delete(policyName);

    // If any agent is currently inferring, buffer for later (with cap)
    if (this.inferring.size > 0) {
      this.bufferForInference(events);
      return;
    }

    this.deliverEvents(events);

    this.emitTrace({
      type: 'gate:debounce-delivered',
      policyName,
      eventCount: events.length,
      timestamp: Date.now(),
    });
  }

  // =========================================================================
  // Event delivery
  // =========================================================================

  private deliverEvents(events: PendingEvent[]): void {
    if (events.length === 0) return;

    const policyNames = [...new Set(events.map(e => e.policyName))];

    // Events whose content the framework already stored at arrival (MCPL
    // channel-incoming / push-event) get a compact REFERENCE — re-quoting
    // them here would inject a duplicate copy of the message minutes after
    // the fact, reading as fresh input the agent may have already handled.
    // Only events with no context entry of their own carry their content.
    const quoted = events.filter(e => !e.inContext);
    const referenced = events.filter(e => e.inContext);

    const lines: string[] = quoted.map(e => `- [${e.policyName}] (${e.eventType}): ${e.content}`);
    if (referenced.length > 0) {
      const byChannel = new Map<string, { count: number; oldest: number; label?: string }>();
      for (const e of referenced) {
        const key = e.channelId ?? '(unknown channel)';
        const entry = byChannel.get(key) ?? { count: 0, oldest: e.timestamp, label: e.channelLabel };
        entry.count += 1;
        entry.oldest = Math.min(entry.oldest, e.timestamp);
        entry.label = entry.label ?? e.channelLabel;
        byChannel.set(key, entry);
      }
      for (const [channelId, { count, oldest, label }] of byChannel) {
        // Prefer the human-readable name; keep the id parenthesized so the
        // agent can still address tools that want the composite id.
        const channel = label ? `#${label} (${channelId})` : channelId;
        const age = Math.round((Date.now() - oldest) / 1000);
        lines.push(
          `- ${count} message${count > 1 ? 's' : ''} in ${channel} ` +
          `(oldest ~${age}s ago) — already shown above at arrival; this is a ` +
          `batched wake, not new content`,
        );
      }
    }

    const text = `[Gate: ${events.length} event${events.length > 1 ? 's' : ''} matched]\n\n${lines.join('\n')}`;

    this.addMessageFn('user', [{ type: 'text', text }], {
      source: 'gate:debounce',
      policies: policyNames,
    });

    for (const agentName of this.getAgentNamesFn()) {
      this.requestInferenceFn(agentName, 'gate:debounce', 'gate');
    }
  }

  // =========================================================================
  // Inference lifecycle
  // =========================================================================

  onInferenceStarted(agentName: string): void {
    this.inferring.add(agentName);
    // A turn is starting — whatever caused it supersedes any pending
    // self-wake. (Arming happens MID-turn via skip_reply, i.e. after this
    // ran for the arming turn, so a fresh arm always survives its own turn.)
    const selfWake = this.selfWakeTimers.get(agentName);
    if (selfWake) {
      clearTimeout(selfWake);
      this.selfWakeTimers.delete(agentName);
    }
  }

  onInferenceEnded(agentName: string): void {
    this.inferring.delete(agentName);

    // Flush inference buffer if no agents are inferring
    if (this.inferring.size === 0 && this.inferenceBuffer.length > 0) {
      const events = this.inferenceBuffer.splice(0);
      // Defer to avoid re-entrancy inside trace callbacks
      queueMicrotask(() => this.deliverEvents(events));
    }
  }

  /** Live inference-gating snapshot for diagnostics (e.g. a SIGUSR2 dump).
   *  A non-empty `inferring` with a stale timestamp + growing `bufferedEvents`
   *  is the signature of the wake-wedge: an agent stuck mid-"inference" so all
   *  incoming events buffer and never trigger. */
  inferenceDiagnostics(): { inferring: string[]; bufferedEvents: number; sleepUntil: number } {
    return {
      inferring: [...this.inferring],
      bufferedEvents: this.inferenceBuffer.length,
      sleepUntil: this.sleepUntil,
    };
  }

  // =========================================================================
  // Inference buffer cap
  // =========================================================================

  /** Called internally when debounce fires during inference. */
  private bufferForInference(events: PendingEvent[]): void {
    for (const event of events) {
      if (this.inferenceBuffer.length >= MAX_INFERENCE_BUFFER) {
        this.inferenceBuffer.shift(); // Drop oldest
      }
      this.inferenceBuffer.push(event);
    }
  }

  // =========================================================================
  // Tool: gate:status
  // =========================================================================

  // =========================================================================
  // Sleep
  // =========================================================================

  /** Begin (or extend) a sleep window of `seconds`. Returns the wake time. */
  setSleep(seconds: number, note?: string, agentName?: string): { until: number } {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    this.sleepUntil = this.now() + ms;
    this.sleepNote = note;
    this.sleepAgent = agentName;
    this.sleepSuppressed = 0;
    // Arm the self-wake: when the window elapses, clear sleep and request an
    // inference so the agent resumes on its own (not dependent on a heartbeat
    // tick or an incoming message). Cancelled by clearSleep()/`wake`.
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => this.wakeFromSleep('sleep-expired'), ms);
    this.reloadPrivilegedIfChanged();
    this.emitTrace({
      type: 'gate:decision',
      eventType: 'sleep:set',
      matchedPolicy: 'asleep',
      trigger: false,
      behavior: 'skip',
      timestamp: this.now(),
    });
    return { until: this.sleepUntil };
  }

  // =========================================================================
  // Self-wake (skip_reply wake_in_seconds)
  // =========================================================================

  /**
   * Arm a one-shot self-wake for `agentName` in `seconds` (clamped to
   * [1, 3600]). Fires a normal inference request when it elapses — no
   * suppression window, unlike sleep. Re-arming replaces the pending timer.
   * Cancelled by the agent's next turn start (see onInferenceStarted):
   * the semantics are "if nothing else wakes me by then, wake me".
   */
  armSelfWake(agentName: string, seconds: number, source = 'skip_reply'): { inMs: number } {
    const ms = Math.max(1_000, Math.min(3_600_000, Math.floor(seconds * 1000)));
    const prev = this.selfWakeTimers.get(agentName);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.selfWakeTimers.delete(agentName);
      this.emitTrace({
        type: 'gate:decision',
        eventType: 'selfwake:fired',
        matchedPolicy: 'self-wake',
        trigger: true,
        behavior: 'always',
        timestamp: this.now(),
      });
      // Compact in-window notice: without it the wake turn contains nothing
      // new, so the agent can't tell WHAT woke it (its own timer vs. a
      // heartbeat) or WHEN. One line, timestamped to the second. Added
      // before the inference request so it rides the wake turn (addMessage's
      // turn-alive guard defers it to that turn's start if needed).
      const nowIso = new Date(this.now()).toISOString().slice(0, 19) + 'Z';
      this.addMessageFn('user', [{
        type: 'text',
        text: `[self-wake] your ${source} timer (${Math.round(ms / 1000)}s) elapsed — now ${nowIso}`,
      }], { source: 'gate:self-wake' });
      this.requestInferenceFn(
        agentName,
        `self-scheduled wake (${source}, ${Math.round(ms / 1000)}s)`,
        'self-wake',
      );
    }, ms);
    this.selfWakeTimers.set(agentName, timer);
    this.emitTrace({
      type: 'gate:decision',
      eventType: 'selfwake:set',
      matchedPolicy: 'self-wake',
      trigger: false,
      behavior: 'skip',
      timestamp: this.now(),
    });
    return { inMs: ms };
  }

  /** End sleep immediately. Returns true if the agent was asleep. */
  clearSleep(): boolean {
    const wasAsleep = this.sleepUntil > this.now();
    this.sleepUntil = 0;
    this.sleepNote = undefined;
    this.sleepAgent = undefined;
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    return wasAsleep;
  }

  /**
   * Self-wake handler: fired by the sleepTimer when a sleep window elapses.
   * Clears the sleep state and requests an inference so the agent wakes on its
   * own — this is what makes `sleep(N)` a real "wake me in N seconds" rather
   * than just a suppression window. No-op if sleep was already cleared (via
   * `wake`) or re-armed to a later time by a fresh `sleep` call.
   */
  private wakeFromSleep(reason: string): void {
    this.sleepTimer = null;
    if (this.sleepUntil === 0 || this.sleepUntil > this.now()) return;
    const note = this.sleepNote;
    const agent = this.sleepAgent;
    this.sleepUntil = 0;
    this.sleepNote = undefined;
    this.sleepAgent = undefined;
    this.emitTrace({
      type: 'gate:decision',
      eventType: 'sleep:expired',
      matchedPolicy: 'asleep',
      trigger: true,
      behavior: 'always',
      timestamp: this.now(),
    });
    const detail = note ? `${reason}: ${note}` : reason;
    const targets = agent ? [agent] : this.getAgentNamesFn();
    for (const a of targets) this.requestInferenceFn(a, detail, 'sleep');
  }

  /** Current sleep state, or null if awake. */
  getSleepState(): { until: number; remainingMs: number; note?: string; suppressed: number } | null {
    const remainingMs = this.sleepUntil - this.now();
    if (remainingMs <= 0) return null;
    return { until: this.sleepUntil, remainingMs, note: this.sleepNote, suppressed: this.sleepSuppressed };
  }

  /** Author id from an event's metadata, across the discord ingest shapes. */
  private extractAuthorId(metadata?: Record<string, unknown>): string | null {
    if (!metadata) return null;
    const author = metadata.author as { id?: unknown } | undefined;
    if (author && author.id != null) return String(author.id);
    if (metadata.authorId != null) return String(metadata.authorId);
    return null;
  }

  /** Load the privileged-users file (bare array or { userIds: [...] }). */
  private loadPrivileged(): void {
    if (!this.privilegedUsersPath) return;
    try {
      if (!existsSync(this.privilegedUsersPath)) {
        this.privilegedUserIds = new Set();
        this.privilegedMtime = 0;
        return;
      }
      this.privilegedMtime = statSync(this.privilegedUsersPath).mtimeMs;
      const raw = JSON.parse(readFileSync(this.privilegedUsersPath, 'utf8'));
      const ids = Array.isArray(raw) ? raw : Array.isArray(raw?.userIds) ? raw.userIds : [];
      this.privilegedUserIds = new Set(ids.map((x: unknown) => String(x)));
    } catch (err) {
      this.configErrors.push(
        `Failed to load privileged-users file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Throttled mtime-based reload of the privileged-users file. */
  private reloadPrivilegedIfChanged(): void {
    if (!this.privilegedUsersPath) return;
    const now = this.now();
    if (now - this.lastPrivilegedCheck < RELOAD_THROTTLE_MS) return;
    this.lastPrivilegedCheck = now;
    try {
      if (!existsSync(this.privilegedUsersPath)) {
        if (this.privilegedUserIds.size > 0) this.privilegedUserIds = new Set();
        return;
      }
      const mtime = statSync(this.privilegedUsersPath).mtimeMs;
      if (mtime !== this.privilegedMtime) this.loadPrivileged();
    } catch {
      /* leave the last-known set in place on a transient stat/read error */
    }
  }

  getToolDefinition(): ToolDefinition {
    return {
      name: 'gate_status',
      description: 'Show the current EventGate configuration, per-policy match counts, debounce state, and any config errors.',
      inputSchema: {
        type: 'object',
      },
    };
  }

  async handleToolCall(): Promise<{ success: boolean; data?: GateStatus; error?: string }> {
    const status = this.getStatus();
    return { success: true, data: status };
  }

  getStatus(): GateStatus {
    const policies: GatePolicyStats[] = this.config.policies.map(p => {
      const stats = this.stats.get(p.name);
      const debounce = this.debounceTimers.get(p.name);
      const result: GatePolicyStats = {
        name: p.name,
        behavior: p.behavior,
        matchCount: stats?.matchCount ?? 0,
        lastMatchTimestamp: stats?.lastMatchTimestamp ?? null,
      };
      if (typeof p.behavior === 'object' && 'debounce' in p.behavior) {
        result.debounceState = {
          pendingCount: debounce?.events.length ?? 0,
          nextDeliveryMs: null, // Timer internals not easily inspectable
        };
      }
      if (typeof p.behavior === 'object' && 'rate_limit' in p.behavior) {
        result.rateLimitState = {
          bucketCount: this.rateLimitBuckets.get(p.name)?.size ?? 0,
          deniedCount: this.rateLimitDenied.get(p.name) ?? 0,
        };
      }
      if (typeof p.behavior === 'object' && 'passive_sample' in p.behavior) {
        result.passiveSampleState = {
          counterCount: this.passiveSampleCounters.get(p.name)?.size ?? 0,
          fireCount: this.passiveSampleFires.get(p.name) ?? 0,
        };
      }
      return result;
    });

    const byEventType: Record<string, { triggered: number; skipped: number }> = {};
    for (const [k, v] of this.defaultByEventType) byEventType[k] = { ...v };

    const sleepState = this.getSleepState();

    return {
      ...(sleepState
        ? {
            sleep: {
              until: sleepState.until,
              remainingMs: sleepState.remainingMs,
              note: sleepState.note,
              suppressed: sleepState.suppressed,
              privilegedCount: this.privilegedUserIds.size,
            },
          }
        : {}),
      configPath: this.configPath,
      configSource: this.configSource,
      lastReloadTimestamp: this.lastReloadTimestamp,
      default: this.config.default ?? 'always',
      script: this.gateScript.status(),
      policies,
      errors: [...this.configErrors],
      totalEvaluations: this.totalEvaluations,
      defaultDecisions: {
        triggered: this.defaultTriggered,
        skipped: this.defaultSkipped,
        byEventType,
      },
    };
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  dispose(): void {
    this.gateScript.dispose();
    for (const state of this.debounceTimers.values()) {
      clearTimeout(state.timer);
    }
    this.debounceTimers.clear();
    for (const timer of this.selfWakeTimers.values()) {
      clearTimeout(timer);
    }
    this.selfWakeTimers.clear();
    this.rateLimitBuckets.clear();
    this.passiveSampleCounters.clear();
    this.rateLimitDenied.clear();
    this.passiveSampleFires.clear();
    this.inferenceBuffer = [];
  }
}
