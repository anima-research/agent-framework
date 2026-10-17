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

import { chmodSync, chownSync, existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  ShadowWarning,
  GateProbeRow,
  UnreadableConfigKept,
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

/** Whether a check made at `last` is still fresh at `now`, less than the
 *  reload throttle ago. A clock stepped backwards since makes it stale, so
 *  the next check runs rather than wait for the clock to catch up. */
function checkedRecently(now: number, last: number): boolean {
  const elapsed = now - last;
  return elapsed >= 0 && elapsed < RELOAD_THROTTLE_MS;
}

/** A read that failed because nothing is at the path. Any other failure
 *  (EACCES on a directory, ELOOP, ENOTDIR) is a file that's there but can't
 *  be read. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

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
  /** Author id of the event (discord snowflake etc.), when the metadata carries
   *  one — a debounced wake names the newest such author as its counterparty. */
  authorId?: string;
  /** MCPL server id the event came from — the namespace for the counterparty
   *  (`<serverId>:user:<id>`), same as the direct channel-incoming path. */
  serverId?: string;
  /** `chat:addressed` (mention / reply-to-bot / DM): an addressed event outranks
   *  newer ambient chatter when a batched wake picks its provenance — the same
   *  rule the framework applies to the turn's speech locus. */
  addressed: boolean;
  /** The REGISTERED (composite) channel id the event arrived on, resolved by
   *  the host at enqueue time. Differs from `channelId` for push events,
   *  whose `channelId` is the adapter's raw id (a bare Discord snowflake for a
   *  DM) — unroutable. Absent when the host could not resolve one. */
  routeChannelId?: string;
}

/**
 * Where a gate-requested wake came from, handed to the framework alongside the
 * reason so the turn's InferenceRequest can carry it (host telemetry stamps
 * "who woke the agent" from it). Ids only, never content or display names.
 */
export interface WakeProvenance {
  /** Composite channel id of the chosen event — telemetry only, never a
   *  speech locus. Omitted for `mcpl:push-event` events, whose channel ids
   *  are raw server ids (unroutable and a second spelling of the same
   *  channel); the framework derives the composite id on the direct path. */
  channelId?: string;
  /** Server-namespaced author id: `<serverId>:user:<id>` (falls back to the
   *  channel id's first segment only when the event carried no server id). */
  counterparty?: string;
  /** True when the chosen event was `chat:addressed`. */
  addressed?: boolean;
  /** Speech locus for the wake: the routable channel of the chosen event,
   *  set ONLY when that event addressed the agent (mention / reply / DM) and
   *  the host resolved its registered channel. A batched wake used to carry
   *  no locus at all, so its reply fell back to the process-global
   *  most-recent-inbound channel — which any ambient message elsewhere,
   *  arriving a second after the DM that caused the wake, could retarget
   *  (2026-09-30: a DM reply published into a guild channel). Ambient-only
   *  batches still set nothing and keep the legacy fallback. */
  routeChannelId?: string;
  /** Timestamp (ms) of the chosen event, so a consumer coalescing several
   *  requests can order by event recency, not by flush order. */
  at?: number;
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

/**
 * Provenance of a batched wake: the newest ADDRESSED channel-bearing event
 * wins (mention / reply / DM outranks newer ambient chatter — the framework's
 * own locus rule); else the newest channel-bearing event. Channel, author and
 * addressed all come from that one event, so they can never disagree.
 */
export function wakeProvenance(events: PendingEvent[]): WakeProvenance | undefined {
  let newest: PendingEvent | undefined;
  let newestAddressed: PendingEvent | undefined;
  for (const e of events) {
    // A resolved route counts as naming a channel only for an ADDRESSED
    // event: a push whose origin declares only `mcplChannelId` (no raw
    // channel id, no author) is still a routable addressed message, and
    // skipping it would leave its wake on the most-recent-inbound fallback.
    // An ambient one stays out: the route is never reported for it, so as
    // the pick it would carry no telemetry at all and hide an earlier event
    // that names its channel and author.
    if (!e.channelId && !e.authorId && !(e.addressed && e.routeChannelId)) continue;
    if (!newest || e.timestamp >= newest.timestamp) newest = e;
    if (e.addressed && (!newestAddressed || e.timestamp >= newestAddressed.timestamp)) newestAddressed = e;
  }
  const pick = newestAddressed ?? newest;
  if (!pick) return undefined;
  // push-event channel ids are the adapter's raw ids (a Discord snowflake):
  // not a composite channel id, so not reported as one
  const channelId = pick.channelId && pick.eventType !== 'mcpl:push-event' ? pick.channelId : undefined;
  const ns = pick.serverId || (pick.channelId ? pick.channelId.split(':')[0] : '') || 'channel';
  return {
    ...(channelId ? { channelId } : {}),
    ...(pick.authorId ? { counterparty: `${ns}:user:${pick.authorId}` } : {}),
    ...(pick.addressed ? { addressed: true } : {}),
    ...(pick.addressed && pick.routeChannelId ? { routeChannelId: pick.routeChannelId } : {}),
    at: pick.timestamp,
  };
}

/**
 * Default route-channel resolution when the host supplies none: a
 * channel-incoming event's channel id is already the registered composite id;
 * a push event's is the adapter's raw id, which only the host can map.
 */
function defaultRouteChannel(info: GateEventInfo): string | undefined {
  return info.eventType === 'mcpl:channel-incoming' && info.channelId ? info.channelId : undefined;
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

  // Validate passthrough — only meaningful on the counting behaviors, where
  // "matched but didn't fire" is a distinct outcome that can fall through.
  // On always/defer/skip/debounce the flag would be a no-op at best and a
  // misleading promise at worst, so reject it loudly instead of ignoring it.
  let passthrough: boolean | undefined;
  if (obj.passthrough !== undefined) {
    if (typeof obj.passthrough !== 'boolean') {
      throw new Error(`Policy "${obj.name}": passthrough must be a boolean`);
    }
    if (obj.passthrough) {
      const counting = typeof behavior === 'object'
        && ('rate_limit' in behavior || 'passive_sample' in behavior);
      if (!counting) {
        throw new Error(
          `Policy "${obj.name}": passthrough is only valid with rate_limit or `
          + `passive_sample behaviors — for "${formatBehavior(behavior)}" there is `
          + 'no non-firing match to fall through on',
        );
      }
      passthrough = true;
    }
  }

  const policy: GatePolicy = { name: obj.name, match, behavior };
  if (resets) policy.resets = resets;
  if (passthrough) policy.passthrough = passthrough;
  return policy;
}

// ---------------------------------------------------------------------------
// Shadow lint — prove (conservatively) when rule ordering makes a rule dead
// ---------------------------------------------------------------------------

/** Set-inclusion helper for exact-string lists. */
function subsetOf(a: string[], b: string[]): boolean {
  return a.every((x) => b.includes(x));
}

/** A glob field on the EARLIER rule is at least as broad as the LATER rule's
 *  when it's absent, the universal "*", or literally identical. Anything
 *  cleverer (real glob subsumption) is out of conservative scope. */
function globAtLeastAsBroad(earlier: string | undefined, later: string | undefined): boolean {
  if (earlier === undefined || earlier === '*') return true;
  return earlier === later;
}

/**
 * Event types for which `earlier` provably matches EVERY event that `later`
 * would match — i.e. the types for which `later` is unreachable when
 * `earlier` sits before it and consumes its matches. Returns null when
 * subsumption can't be proven (which is not proof of safety — the lint is
 * deliberately one-sided so every warning it emits is true).
 */
function subsumedEventTypes(earlier: GatePolicy, later: GatePolicy): string[] | 'all' | null {
  const e = earlier.match;
  const l = later.match;

  // Scope: which of `later`'s event types does `earlier` cover?
  let covered: string[] | 'all';
  if (!e.scope || e.scope.length === 0) {
    covered = l.scope && l.scope.length > 0 ? l.scope : 'all';
  } else if (!l.scope || l.scope.length === 0) {
    // `later` matches all types; `earlier` only consumes its own scope, so
    // the shadow is partial — exactly those types.
    covered = e.scope;
  } else {
    const overlap = l.scope.filter((t) => e.scope!.includes(t));
    if (overlap.length === 0) return null;
    covered = overlap;
  }

  // Every remaining discriminator on `earlier` must be at least as broad as
  // `later`'s, otherwise some `later` events slip past `earlier`.
  if (!globAtLeastAsBroad(e.source, l.source)) return null;
  if (!globAtLeastAsBroad(e.channel, l.channel)) return null;
  if (!globAtLeastAsBroad(e.mount, l.mount)) return null;
  if (!globAtLeastAsBroad(e.pathGlob, l.pathGlob)) return null;

  if (e.filter) {
    if (!l.filter || e.filter.type !== l.filter.type || e.filter.pattern !== l.filter.pattern) {
      return null;
    }
  }

  // metadataTrue / tagsAny are OR-lists: earlier subsumes when later's list
  // is a subset of earlier's (any event satisfying later then satisfies
  // earlier too). tagsAll / tagsNone are AND/NOT constraints: earlier
  // subsumes when its constraints are a subset of later's.
  if (e.metadataTrue && e.metadataTrue.length > 0) {
    if (!l.metadataTrue || !subsetOf(l.metadataTrue, e.metadataTrue)) return null;
  }
  if (e.tagsAny && e.tagsAny.length > 0) {
    if (!l.tagsAny || !subsetOf(l.tagsAny, e.tagsAny)) return null;
  }
  if (e.tagsAll && !subsetOf(e.tagsAll, l.tagsAll ?? [])) return null;
  if (e.tagsNone && !subsetOf(e.tagsNone, l.tagsNone ?? [])) return null;

  return covered;
}

/**
 * Find rules made unreachable by earlier, broader rules (first match wins).
 * The 2026-08-08 Mythos incident is the canonical catch: a prepended
 * `{scope:[mcpl:channel-incoming]}` sampler silently made the
 * direct-address and mention rules dead for the whole incoming lane.
 * `passthrough` observers shadow nothing — non-firing matches fall through.
 */
export function findShadowedPolicies(policies: GatePolicy[]): ShadowWarning[] {
  const out: ShadowWarning[] = [];
  for (let i = 0; i < policies.length; i++) {
    const earlier = policies[i];
    if (earlier.passthrough) continue;
    for (let j = i + 1; j < policies.length; j++) {
      const covered = subsumedEventTypes(earlier, policies[j]);
      if (covered) {
        out.push({ earlier: earlier.name, later: policies[j].name, eventTypes: covered });
      }
    }
  }
  return out;
}

/** Human-readable one-liner for a ShadowWarning, used in tool results,
 *  traces, and gate_status alike so the same hazard reads the same way
 *  everywhere. */
export function formatShadowWarning(w: ShadowWarning): string {
  const types = w.eventTypes === 'all' ? 'ALL event types' : w.eventTypes.join(', ');
  return `rule "${w.earlier}" makes "${w.later}" unreachable for ${types} `
    + `(first match wins — every event "${w.later}" would match is consumed by "${w.earlier}" first)`;
}

/** What a wake-rule tool tells the agent when its change kept a copy of an unreadable gate.json. */
export function formatUnreadableKept(kept: UnreadableConfigKept): string {
  return `gate.json couldn't be read (${kept.reason}), so a copy of it was kept at ${kept.keptPath}, and gate.json `
    + 'now holds the rules that were in force, with this change. What the copy holds is not in force; whoever '
    + 'runs this host can restore rules from it.';
}

/** The privileged-users file's error when some entries of its list aren't user ids. */
function skippedPrivilegedIds(skipped: unknown[], loaded: number): string {
  const one = skipped.length === 1;
  const shown = skipped.slice(0, 5).map((x) => {
    if (typeof x === 'number' && Number.isInteger(x)) {
      return `${x} (a number this large can't be read exactly: write the id as a string, in quotes)`;
    }
    const json = JSON.stringify(x) ?? String(x);
    return json.length > 40 ? `${json.slice(0, 39)}…` : json;
  });
  const more = skipped.length > shown.length ? `, and ${skipped.length - shown.length} more` : '';
  const rest = loaded === 0 ? 'no id loaded, so no one is privileged' : `${loaded} ${loaded === 1 ? 'id' : 'ids'} did load`;
  return `${skipped.length} ${one ? 'entry' : 'entries'} in the privileged-users file ${one ? "isn't a user id" : "aren't user ids"}, `
    + `so ${one ? 'it was' : 'they were'} skipped: ${shown.join(', ')}${more}. A user id is a non-empty string, or a safe integer `
    + `(a whole number within 2^53 - 1 of zero); ${rest}.`;
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
  /** The text of gate.json whose rules are in force, from a load or a write.
   *  A reload parses the file again only when its text differs; a file that
   *  holds it again after failing to load (a chmod that makes it readable,
   *  an edit undone) needs nothing applied, only its error cleared. */
  private configText: string | undefined;
  private lastReloadCheck: number = 0;
  private configSource: 'file' | 'initial' | 'default' = 'default';
  private lastReloadTimestamp: number | null = null;
  /** The current problem with each file the gate reads, one each, replaced
   *  whenever that file is read again (gate_status `errors`). */
  private configError: string | null = null;
  private privilegedError: string | null = null;
  /** Why the startup couldn't seed or reconcile gate.json, kept apart from
   *  gate.json's own error so the load that follows can't clear it, until
   *  gate.json loads new text or is written. */
  private startupError: string | null = null;

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
  /** Host quiesce suppression — see setQuiesced. */
  private quiesced = false;
  /** Lifetime count of buffer-cap evictions (see bufferForInference). */
  private droppedBufferedEvents = 0;

  // Per-policy stats
  private stats = new Map<string, PolicyStats>();

  // Shadow-lint cache (see refreshShadowWarnings) — recomputed on every
  // config change, fingerprinted so an unchanged hazard set doesn't re-trace.
  private shadowWarningsCache: ShadowWarning[] = [];
  private shadowWarningsFingerprint = '[]';

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
  /** The privileged-users file's text as last read, whether or not it loaded;
   *  undefined when it was missing or its last read failed. */
  private privilegedText: string | undefined;
  private lastPrivilegedCheck = 0;

  // Dependency-injected callbacks
  private emitTrace: (event: TraceEventLike) => void;
  private addMessageFn: (
    participant: string,
    content: Array<{ type: 'text'; text: string }>,
    metadata?: Record<string, unknown>,
    /** Registry agent to deliver into; absent = primary (historical). */
    forAgent?: string,
  ) => unknown;
  private requestInferenceFn: (agentName: string, reason: string, source: string, provenance?: WakeProvenance) => void;
  private getAgentNamesFn: () => string[];
  private resolveRouteChannelFn: (info: GateEventInfo) => string | undefined;
  /** Clock injection — keeps the new rate_limit / passive_sample paths
   *  testable without monkey-patching Date.now globally. */
  private now: () => number;

  constructor(opts: {
    configPath: string;
    initialConfig?: GateConfig;
    privilegedUsersPath?: string;
    emitTrace: (event: TraceEventLike) => void;
    addMessage: (
      participant: string,
      content: Array<{ type: 'text'; text: string }>,
      metadata?: Record<string, unknown>,
      forAgent?: string,
    ) => unknown;
    requestInference: (agentName: string, reason: string, source: string, provenance?: WakeProvenance) => void;
    getAgentNames: () => string[];
    /** Optional clock — defaults to Date.now. Tests inject for deterministic time. */
    now?: () => number;
    /** Per-event timeout (ms) for the optional gate.js script. Default 50. */
    scriptTimeoutMs?: number;
    /** Map an event to the registered channel it arrived on (the host knows
     *  how push-event origins compose into channel ids). Default: a
     *  channel-incoming event's own channel id; nothing for push events. */
    resolveRouteChannel?: (info: GateEventInfo) => string | undefined;
  }) {
    this.configPath = opts.configPath;
    this.privilegedUsersPath = opts.privilegedUsersPath;
    this.emitTrace = opts.emitTrace;
    this.addMessageFn = opts.addMessage;
    this.requestInferenceFn = opts.requestInference;
    this.getAgentNamesFn = opts.getAgentNames;
    this.resolveRouteChannelFn = opts.resolveRouteChannel ?? defaultRouteChannel;
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
        // Its own slot: the load below would clear gate.json's error.
        this.startupError = `Failed to seed/reconcile gate.json: ${msg}`;
      }
    }

    // Load config
    const read = this.readConfigFile();
    if (read.state === 'loaded') {
      this.config = read.config;
      this.configText = read.text;
      this.configSource = 'file';
    } else {
      this.config = opts.initialConfig ?? { ...DEFAULT_CONFIG };
    }
    this.compiledPolicies = this.compilePolicies(this.config);
    this.refreshShadowWarnings('startup');

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
    const read = this.readConfigFile();
    return read.state === 'loaded' ? read.config : null; // Caller keeps previous config
  }

  /**
   * gate.json as it is on disk: absent, loaded, or there but unreadable (it
   * can't be read, isn't JSON, or holds something validateConfig refuses),
   * with its bytes when it could be read, since text decoded from a file that
   * isn't UTF-8 isn't what it held. Reading applies nothing: whoever
   * applies a loaded config records its text as `configText`. With
   * `unlessUnchanged`, a file whose text is `configText` comes back
   * `unchanged`, unparsed, since the rules in force came from it.
   */
  private readConfigFile(opts?: { unlessUnchanged?: boolean }):
    | { state: 'absent' }
    | { state: 'unchanged' }
    | { state: 'loaded'; config: GateConfig; text: string }
    | { state: 'unreadable'; error: string; bytes?: Buffer } {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.configPath);
    } catch (err) {
      if (!isMissing(err)) return this.configUnreadable(err);
      // No file is no problem with it: the rules in force stay.
      this.configError = null;
      return { state: 'absent' };
    }
    const raw = bytes.toString('utf-8');
    if (opts?.unlessUnchanged && raw === this.configText) {
      // The file holds the text in force, which loaded, so it has no problem.
      this.configError = null;
      return { state: 'unchanged' };
    }
    try {
      const config = validateConfig(JSON.parse(raw));
      this.configError = null;
      return { state: 'loaded', config, text: raw };
    } catch (err) {
      return { ...this.configUnreadable(err), bytes };
    }
  }

  /**
   * gate.json's current error, replacing the last one, and traced and logged
   * when it's new, so an edit that doesn't load is in the log once.
   */
  private configUnreadable(err: unknown): { state: 'unreadable'; error: string } {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== this.configError) {
      console.error(`[gate] ${this.configPath} couldn't be read (${msg}), so what it holds isn't in force`);
      this.emitTrace({
        type: 'gate:config-error',
        error: msg,
        configPath: this.configPath,
        timestamp: Date.now(),
      });
    }
    this.configError = msg;
    return { state: 'unreadable', error: msg };
  }

  /**
   * The rules a policy change starts from: gate.json as it is on disk, or the
   * rules in force when it's absent or unreadable. An unreadable file comes
   * back with its error, and with its bytes when it could be read, for
   * keepUnreadableConfig before anything is written over it.
   */
  private configForChange(): { config: GateConfig; unreadable?: { error: string; bytes?: Buffer } } {
    const read = this.readConfigFile();
    if (read.state === 'loaded') return { config: read.config };
    if (read.state === 'unreadable') return { config: this.config, unreadable: { error: read.error, bytes: read.bytes } };
    return { config: this.config };
  }

  /**
   * Keep a copy of an unreadable gate.json, byte for byte as the change read it, at
   * `gate.json.unreadable-<UTC time>` beside it, before the rules in force are
   * written over it in place, so what it held (often an operator's
   * unfinished edit) isn't lost. A copy, not a rename, so gate.json itself
   * stays where it is: a symlink keeps its target, the file its mode and
   * owner, and a single-file bind mount works. Returns where the copy is.
   * Throws, so the caller writes nothing, when the file couldn't be read at
   * all (there's nothing to copy, and a file the process can't read is often
   * one its operator closed off on purpose) or when the copy can't be made.
   */
  private keepUnreadableConfig(unreadable: { error: string; bytes?: Buffer }): string {
    const reason = unreadable.error;
    if (unreadable.bytes === undefined) {
      throw new Error(`gate.json couldn't be read (${reason}), so it can't be kept, and nothing was written over it.`);
    }
    // No colons: Windows doesn't allow them in a file name.
    const stamp = new Date(this.now()).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
    const base = `${this.configPath}.unreadable-${stamp}`;
    // The copy is no more readable than gate.json: it's created owner-only,
    // then given gate.json's group, and only then its permission bits. A copy
    // that can't take the group (this process isn't in it), or whose
    // gate.json can't be stat'd, stays owner-only. So does the copy of a
    // gate.json that's a symbolic link: what keeps others out of the file it
    // points to can be a directory on the way there, and the copy, beside the
    // link, isn't behind it.
    let gateFile: { gid: number; mode: number } | undefined;
    try {
      const file = lstatSync(this.configPath);
      if (!file.isSymbolicLink()) gateFile = file;
    } catch { /* owner-only */ }
    for (let n = 1; ; n++) {
      const kept = n === 1 ? base : `${base}-${n}`;
      try {
        // An exclusive create, so a copy never replaces an earlier one.
        writeFileSync(kept, unreadable.bytes, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EEXIST') continue;
        // A copy cut short is this call's own file: remove it, so nothing is left.
        if (e.syscall !== 'open') {
          try { unlinkSync(kept); } catch { /* it's named below */ }
        }
        throw new Error(
          `gate.json couldn't be read (${reason}), and keeping a copy of it at ${kept} failed (${e.message ?? String(err)}), `
          + 'so nothing was written.',
        );
      }
      if (gateFile) {
        try {
          // The copy's own owner, this process, rather than -1 for "unchanged",
          // which Bun 1.3.14 refuses with EPERM.
          chownSync(kept, process.geteuid?.() ?? -1, gateFile.gid);
          chmodSync(kept, gateFile.mode & 0o777);
        } catch { /* it stays owner-only */ }
      }
      console.error(`[gate] ${this.configPath} couldn't be read (${reason}); kept a copy at ${kept} before writing the rules in force`);
      this.emitTrace({
        type: 'gate:config-kept',
        configPath: this.configPath,
        keptPath: kept,
        error: reason,
        timestamp: Date.now(),
      });
      return kept;
    }
  }

  /**
   * The copies keepUnreadableConfig made that are still beside gate.json,
   * oldest first, each with what to do with it, for gate_status: the moment a
   * copy is made reaches only the log, the trace and the change's caller, and
   * the copy exists to be found later.
   */
  private keptCopies(): string[] {
    const dir = dirname(this.configPath);
    const prefix = `${basename(this.configPath)}.unreadable-`;
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.startsWith(prefix));
    } catch {
      return [];
    }
    return names
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => `${join(dir, name)}: a copy of gate.json, kept when it couldn't be read. Nothing in it is in force. `
        + "To use it, fix it and copy it over gate.json. Once it isn't needed, remove it.");
  }

  /**
   * writeConfig, after keepUnreadableConfig may have kept a copy of gate.json:
   * then a write that fails names the copy, since what the file held may now
   * be only there.
   */
  private writeConfigAfterKeep(config: GateConfig, kept: UnreadableConfigKept | undefined): void {
    try {
      this.writeConfig(config);
    } catch (err) {
      if (!kept) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} A copy of what gate.json held when it couldn't be read is kept at ${kept.keptPath}.`, { cause: err });
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
    if (checkedRecently(now, this.lastReloadCheck)) return;
    this.lastReloadCheck = now;

    try {
      // Missing, unchanged or unreadable: the rules in force stay.
      const read = this.readConfigFile({ unlessUnchanged: true });
      if (read.state !== 'loaded') return;
      const newConfig = read.config;

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
      // Recorded only now that its rules are in force, so a reload that
      // throws before here is tried again at the next check.
      this.configText = read.text;
      this.configSource = 'file';
      // New text in gate.json now decides the rules, not the startup's.
      this.startupError = null;
      this.lastReloadTimestamp = now;
      this.refreshShadowWarnings('reload');

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
      // The rules in force stay, and the next check tries again.
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
   * without waiting for the throttled reload.
   *
   * The freshest on-disk config is re-read first, so a concurrent operator edit
   * isn't clobbered. When gate.json is there but won't load, the change starts
   * from the rules in force, after a copy of the file is kept beside it
   * (keepUnreadableConfig) and reported to `onUnreadableKept` once the change
   * is written. A policy with the same `name` is replaced IN PLACE when no
   * `position` is given (order preserved); WITH a `position` it is moved there
   * — so re-issuing a rule is also how you reposition it. New policies append
   * by default; `'prepend'` puts one at the very front (ahead of EVERYTHING,
   * including addressed-message wake rules — see the shadow lint), and the
   * anchored forms `{before: name}` / `{after: name}` insert relative to an
   * existing rule, which is almost always the safer way to order a sampler
   * or debounce against a specific catch-all.
   *
   * Throws, writing nothing, for an invalid policy, a placement it can't make,
   * or a gate.json that can't be read or kept; and throws when the write
   * fails, naming any copy kept.
   */
  addPolicy(
    rawPolicy: unknown,
    options?: {
      position?: 'append' | 'prepend' | { before: string } | { after: string };
      onUnreadableKept?: (kept: UnreadableConfigKept) => void;
    },
  ): GatePolicy {
    const policy = validatePolicy(rawPolicy);
    const { config: current, unreadable } = this.configForChange();
    const policies = [...current.policies];
    const idx = policies.findIndex((p) => p.name === policy.name);
    const position = options?.position;

    if (idx >= 0 && position === undefined) {
      policies[idx] = policy; // replace in place, order preserved
    } else {
      if (idx >= 0) policies.splice(idx, 1); // repositioning a known rule
      if (position === 'prepend') {
        policies.unshift(policy);
      } else if (position !== undefined && typeof position === 'object') {
        const anchorName = 'before' in position ? position.before : position.after;
        const anchorIdx = policies.findIndex((p) => p.name === anchorName);
        if (anchorIdx < 0) {
          throw new Error(
            `addPolicy: no policy named "${anchorName}" to anchor on — `
            + `have: [${policies.map((p) => p.name).join(', ')}]`,
          );
        }
        policies.splice('before' in position ? anchorIdx : anchorIdx + 1, 0, policy);
      } else {
        policies.push(policy);
      }
    }

    const kept = unreadable !== undefined
      ? { keptPath: this.keepUnreadableConfig(unreadable), reason: unreadable.error }
      : undefined;
    this.writeConfigAfterKeep({ ...current, policies }, kept);
    if (kept) options?.onUnreadableKept?.(kept);
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
   * that name exists (nothing written). Freshest on-disk config is re-read first,
   * and a copy of a gate.json that won't load is kept before it's written over
   * (see addPolicy). Throws when gate.json can't be read or kept, or when the
   * write fails (naming any copy kept); the rule then stays in force, with its
   * state.
   */
  removePolicy(name: string, options?: { onUnreadableKept?: (kept: UnreadableConfigKept) => void }): boolean {
    const { config: current, unreadable } = this.configForChange();
    if (!current.policies.some((p) => p.name === name)) {
      return false;
    }
    const kept = unreadable !== undefined
      ? { keptPath: this.keepUnreadableConfig(unreadable), reason: unreadable.error }
      : undefined;
    const policies = current.policies.filter((p) => p.name !== name);
    this.writeConfigAfterKeep({ ...current, policies }, kept);
    // Only once the write has succeeded, so a failed keep or write leaves the
    // rule in force with its state: deliver any pending debounce batch, then
    // drop timers, buckets and counters.
    this.clearPolicyState(name, { deliverPendingDebounce: true });
    this.stats.delete(name);
    if (kept) options?.onUnreadableKept?.(kept);
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
   * file, swap in the compiled policies, and keep the text written as
   * `configText`, so `reloadIfChanged` doesn't parse it again. Throws
   * if the write fails (disk/permission) — callers surface it as a tool error.
   */
  private writeConfig(config: GateConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const text = JSON.stringify(config, null, 2) + '\n';
    writeFileSync(this.configPath, text);
    this.configText = text;
    this.config = config;
    this.compiledPolicies = this.compilePolicies(config);
    this.refreshShadowWarnings('policy-mutation');
    this.configSource = 'file';
    this.configError = null;
    this.startupError = null;
    this.lastReloadTimestamp = Date.now();
  }

  // =========================================================================
  // Policy matching — first match wins (passthrough observers excepted; the
  // match/decide loop lives inline in evaluate() and probe())
  // =========================================================================

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
      const isHeartbeat =
        info.metadata?.source === 'heartbeat' || info.serverId === 'heartbeat';
      const authorId = this.extractAuthorId(info.metadata);
      const privileged = this.isPrivilegedUser(authorId);
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
    //
    // Declarative policies: first match wins — EXCEPT `passthrough` observers,
    // which consume the event only when their counting behavior actually
    // fires. A passthrough policy that matched-but-didn't-fire records its
    // count and evaluation continues, so a density sampler placed early can
    // no longer swallow the addressed-message rules behind it.
    const scripted = this.gateScript.evaluate(info);
    let decision: GateDecision | null = null;
    const observed: string[] = [];
    if (scripted != null) {
      decision = this.computeDecision({ name: 'gate.js', match: {}, behavior: scripted }, info);
    } else {
      for (const compiled of this.compiledPolicies) {
        if (!this.compiledMatches(compiled, info)) continue;
        const candidate = this.computeDecision(compiled.policy, info);
        if (candidate.trigger || !compiled.policy.passthrough) {
          decision = candidate;
          break;
        }
        observed.push(compiled.policy.name); // counted, didn't fire, fell through
      }
    }

    this.totalEvaluations++;
    if (!decision) {
      decision = this.computeDecision(null, info);
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
    if (observed.length > 0) decision.observed = observed;

    this.emitTrace({
      type: 'gate:decision',
      eventType: info.eventType,
      serverId: info.serverId || undefined,
      channelId: info.channelId || undefined,
      matchedPolicy: decision.policyName,
      trigger: decision.trigger,
      behavior: formatBehavior(decision.behavior),
      ...(observed.length > 0 ? { observed } : {}),
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
  // Dry-run probes — side-effect-free "what would this event do right now"
  // =========================================================================

  /**
   * Non-mutating twin of the behavior decision: would this policy trigger for
   * this event, given CURRENT counter/bucket state? Reads state, never writes
   * it — no stats, no traces, no counter increments, no debounce batching.
   */
  private wouldTrigger(policy: GatePolicy, info: GateEventInfo): boolean {
    const b = policy.behavior;
    if (b === 'always') return true;
    if (b === 'defer' || b === 'skip') return false;
    if (typeof b === 'object') {
      if ('debounce' in b) return false; // batches; never triggers inline
      if ('rate_limit' in b) {
        const cfg = b.rate_limit;
        const key = this.resolveKey(info.metadata, cfg.keyBy);
        const bucket = this.rateLimitBuckets.get(policy.name)?.get(key);
        if (!bucket) return true; // fresh bucket starts full
        let tokens = bucket.tokens;
        if (tokens < cfg.tokens) {
          const elapsed = Math.max(0, this.now() - bucket.lastRefill);
          tokens = Math.min(cfg.tokens, tokens + Math.floor(elapsed / cfg.refillIntervalMs));
        }
        return tokens > 0;
      }
      if ('passive_sample' in b) {
        const cfg = b.passive_sample;
        const key = this.resolveKey(info.metadata, cfg.keyBy);
        const count = this.passiveSampleCounters.get(policy.name)?.get(key) ?? 0;
        return count + 1 >= cfg.every;
      }
    }
    return false;
  }

  /**
   * Evaluate an event against the declarative policy table WITHOUT side
   * effects: no counters advance, no debounce batches form, no stats or
   * traces are recorded, and sleep suppression is ignored (a probe asks
   * about the table, not the moment). gate.js is not consulted — a script
   * may be stateful, and a probe must never perturb state.
   */
  probe(info: GateEventInfo): GateDecision {
    for (const compiled of this.compiledPolicies) {
      if (!this.compiledMatches(compiled, info)) continue;
      const trigger = this.wouldTrigger(compiled.policy, info);
      if (trigger || !compiled.policy.passthrough) {
        return { trigger, policyName: compiled.policy.name, behavior: compiled.policy.behavior };
      }
    }
    const trigger = (this.config.default ?? 'always') === 'always';
    return { trigger, policyName: null, behavior: this.config.default ?? 'always' };
  }

  /**
   * Probe a canonical set of synthetic chat/heartbeat events and report which
   * rule wins each and whether it would wake. Backs the before/after table in
   * the wake_add_rule result — the point where a rule change's real semantics
   * must become legible (af#105; the Mythos stand-back-density incident would
   * have been visible as `dm: discord-direct-address → stand-back-density`).
   * Probes are representative shapes, not an exhaustive event space — rules
   * keyed on specific channels/mounts may not match any probe.
   */
  probeTable(): GateProbeRow[] {
    const chat = (
      label: string,
      eventType: string,
      metadata: Record<string, unknown>,
      tags: string[],
    ): { label: string; info: GateEventInfo } => ({
      label,
      info: {
        content: `[probe] ${label}`,
        eventType,
        serverId: 'discord',
        channelId: '',
        metadata: { ...metadata, eventType },
        tags,
      },
    });

    const probes = [
      chat('dm (open channel)', 'mcpl:channel-incoming', { isDM: true, isMention: true },
        ['chat:dm', 'chat:private', 'chat:addressed', 'chat:from-human']),
      chat('dm (closed channel)', 'mcpl:push-event', { isDM: true, isMention: true },
        ['chat:dm', 'chat:private', 'chat:addressed', 'chat:from-human']),
      chat('explicit mention (open channel)', 'mcpl:channel-incoming',
        { isMention: true, isExplicitMention: true },
        ['chat:mention', 'chat:addressed', 'chat:from-human']),
      chat('explicit mention (closed channel)', 'mcpl:push-event',
        { isMention: true, isExplicitMention: true },
        ['chat:mention', 'chat:addressed', 'chat:from-human']),
      chat('reply to you', 'mcpl:channel-incoming', { isMention: true, isReplyToBot: true },
        ['chat:reply', 'chat:addressed', 'chat:from-human']),
      chat('ambient (human)', 'mcpl:channel-incoming', {},
        ['chat:ambient', 'chat:from-human']),
      chat('ambient (bot)', 'mcpl:channel-incoming', { isBot: true },
        ['chat:ambient', 'chat:from-bot']),
      {
        label: 'heartbeat',
        info: {
          content: '[probe] heartbeat',
          eventType: 'mcpl:push-event',
          serverId: 'heartbeat',
          channelId: '',
          metadata: { source: 'heartbeat', eventType: 'mcpl:push-event' },
        } as GateEventInfo,
      },
    ];

    return probes.map(({ label, info }) => {
      const d = this.probe(info);
      return {
        probe: label,
        eventType: info.eventType,
        policy: d.policyName,
        behavior: d.policyName === null
          ? `default:${formatBehavior(d.behavior)}`
          : formatBehavior(d.behavior),
        wouldWake: d.trigger,
      };
    });
  }

  // =========================================================================
  // Shadow lint surface
  // =========================================================================

  /** Current shadow-lint findings for the live policy order. Fresh compute —
   *  cheap (policy lists are tens of entries at most). */
  lintShadows(): ShadowWarning[] {
    return findShadowedPolicies(this.config.policies);
  }

  /**
   * Recompute shadow warnings and, when the set changed and is non-empty,
   * emit a `gate:shadow-warnings` trace so the hazard lands in ops
   * observability at the moment the order changed — not at the next missed
   * DM. Called from writeConfig and reloadIfChanged.
   */
  private refreshShadowWarnings(reason: string): void {
    const warnings = this.lintShadows();
    const fingerprint = JSON.stringify(warnings);
    if (fingerprint === this.shadowWarningsFingerprint) return;
    this.shadowWarningsFingerprint = fingerprint;
    this.shadowWarningsCache = warnings;
    if (warnings.length > 0) {
      this.emitTrace({
        type: 'gate:shadow-warnings',
        reason,
        warnings: warnings.map(formatShadowWarning),
        timestamp: this.now(),
      });
    }
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

  /** Registered channel for an event; a resolver fault never breaks gating. */
  private routeChannelFor(info: GateEventInfo): string | undefined {
    try {
      return this.resolveRouteChannelFn(info) || undefined;
    } catch {
      return undefined;
    }
  }

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
      authorId: this.extractAuthorId(info.metadata) ?? undefined,
      serverId: info.serverId || undefined,
      addressed: Array.isArray(info.tags) && info.tags.includes('chat:addressed'),
      routeChannelId: this.routeChannelFor(info),
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

    // If any agent is currently inferring — or the host is quiesced — buffer
    // for later (with cap). While quiesced, delivering would write a
    // "[Gate: N events]" message into the very context being operated on
    // mid-surgery; buffering composes them and they land at resume.
    if (this.inferring.size > 0 || this.quiesced) {
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
        // The registered id when known, so this line names the channel the
        // same way routing notices and send tools do (a push event's own
        // channelId is the adapter's raw id).
        const key = e.routeChannelId ?? e.channelId ?? '(unknown channel)';
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

    // Provenance of the batched wake (who/where woke the agent): the newest
    // ADDRESSED event first, else the newest event naming a channel or an
    // author; channel + author + addressed from that ONE event. When that
    // event addressed the agent and its registered channel is known,
    // `routeChannelId` names the turn's speech locus too — the reply goes
    // back to whoever addressed the agent, not to whichever channel last saw
    // any traffic. Ambient-only batches carry telemetry only.
    const provenance = wakeProvenance(events);
    for (const agentName of this.getAgentNamesFn()) {
      this.requestInferenceFn(agentName, 'gate:debounce', 'gate', provenance);
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
    this.flushInferenceBufferIfClear();
  }

  /**
   * Host quiesce suppression (issue #122). While set, debounce firings buffer
   * instead of writing gate messages into context; clearing it flushes the
   * buffer through the same path a turn's end uses. Self-wake and sleep-expiry
   * timers deliberately do NOT route through this — their inference requests
   * are per-agent targeted pushes that the framework's quiesce wake gate parks
   * and releases at resume, whereas the buffer's deliverEvents broadcasts a
   * wake to every agent.
   */
  setQuiesced(quiesced: boolean): void {
    if (this.quiesced === quiesced) return;
    this.quiesced = quiesced;
    if (!quiesced) this.flushInferenceBufferIfClear();
  }

  private flushInferenceBufferIfClear(): void {
    if (this.quiesced) return;
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
  inferenceDiagnostics(): {
    inferring: string[];
    bufferedEvents: number;
    droppedBufferedEvents: number;
    sleepUntil: number;
  } {
    return {
      inferring: [...this.inferring],
      bufferedEvents: this.inferenceBuffer.length,
      droppedBufferedEvents: this.droppedBufferedEvents,
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
        // Telemetry (issue #122): quiesce stretches buffering from
        // single-inference minutes to operator-length windows, so silent
        // eviction is no longer a corner case — count and log it, or the
        // resume flush reads as complete when it isn't.
        this.droppedBufferedEvents++;
        if (this.droppedBufferedEvents % 50 === 1) {
          console.error(
            `[gate] inference buffer cap (${MAX_INFERENCE_BUFFER}) — dropped ` +
            `${this.droppedBufferedEvents} oldest buffered event(s)` +
            `${this.quiesced ? ' during quiesce' : ''}; the flush on release will be incomplete`,
          );
        }
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
      // Deliver the notice into the WAKING agent's window — a self-wake
      // armed by a non-primary agent (e.g. a subconscious cadence) must not
      // narrate itself into the primary's context.
      this.addMessageFn('user', [{
        type: 'text',
        text: `[self-wake] your ${source} timer (${Math.round(ms / 1000)}s) elapsed — now ${nowIso}`,
      }], { source: 'gate:self-wake' }, agentName);
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

  /**
   * Whether an author id is on the privileged-users list (hot-reloaded).
   * Shared by sleep bypass and tune-out wake classification (#77: wakes are
   * "mentions, gate-privileged authors, etc.").
   */
  isPrivilegedUser(authorId: string | null | undefined): boolean {
    if (!authorId) return false;
    this.reloadPrivilegedIfChanged();
    return this.privilegedUserIds.has(authorId);
  }

  /**
   * Read the privileged-users file: a list of user ids, or `{"userIds": [...]}`,
   * each a non-empty string or a safe integer (a whole number within 2^53 - 1 of zero). An absent file
   * means no one is privileged. A file that can't be read, isn't JSON, or
   * holds no list leaves the list that last loaded in this process in effect
   * (none, at startup), with its error in gate_status until the file is read
   * again. In a list, an entry that isn't a user id is skipped, and named in
   * the file's error, and the rest load. With `unlessUnchanged`, a file whose
   * text is the text last read isn't parsed again.
   */
  private loadPrivileged(opts?: { unlessUnchanged?: boolean }): void {
    if (!this.privilegedUsersPath) return;
    const failed = (why: string): string => `Failed to load privileged-users file: ${why}`;
    let raw: string;
    try {
      raw = readFileSync(this.privilegedUsersPath, 'utf8');
    } catch (err) {
      // Read again next time: a file can become readable with its text
      // unchanged, as a chmod makes it.
      this.privilegedText = undefined;
      if (isMissing(err)) {
        this.privilegedUserIds = new Set();
        this.privilegedError = null;
      } else {
        this.privilegedError = failed(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (opts?.unlessUnchanged && raw === this.privilegedText) return;
    this.privilegedText = raw;
    let ids: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      ids = Array.isArray(parsed) ? parsed : (parsed as { userIds?: unknown } | null)?.userIds;
    } catch (err) {
      this.privilegedError = failed(err instanceof Error ? err.message : String(err));
      return;
    }
    // A file that parses but holds no list hasn't loaded either: it used to
    // mean no one is privileged, without a word.
    if (!Array.isArray(ids)) {
      this.privilegedError = failed('expected a list of user ids, or {"userIds": [...]}');
      return;
    }
    const loaded = new Set<string>();
    const skipped: unknown[] = [];
    for (const id of ids) {
      if (typeof id === 'string' && id !== '') loaded.add(id);
      // JSON.parse has already rounded an integer past 2^53, and the rounded
      // value can be another user's id, so it's skipped rather than loaded.
      else if (typeof id === 'number' && Number.isSafeInteger(id)) loaded.add(String(id));
      else skipped.push(id);
    }
    this.privilegedUserIds = loaded;
    this.privilegedError = skipped.length > 0 ? skippedPrivilegedIds(skipped, loaded.size) : null;
  }

  /** At most once a second, the privileged-users file read again, and loaded when its text has changed. */
  private reloadPrivilegedIfChanged(): void {
    if (!this.privilegedUsersPath) return;
    const now = this.now();
    if (checkedRecently(now, this.lastPrivilegedCheck)) return;
    this.lastPrivilegedCheck = now;
    this.loadPrivileged({ unlessUnchanged: true });
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
    // What's in force now: each file read again if a check is due, as the
    // next event would.
    this.reloadIfChanged();
    this.reloadPrivilegedIfChanged();
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
      errors: [this.configError, this.startupError, this.privilegedError].filter((e): e is string => e !== null),
      shadowWarnings: this.shadowWarningsCache.map(formatShadowWarning),
      keptCopies: this.keptCopies(),
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
