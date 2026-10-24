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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GateScript } from './gate-script.js';
import { canonical, duplicateName, lastRecipePath, noChanges, reconcileLine, reconcileWithRecipe, ruleName, type WrittenConfig } from './recipe-reconcile.js';
import { closestNames, isNearMiss } from '../closest-names.js';
import { MAX_TIMER_MS } from '../deadline-timer.js';
import { safeSlice } from '../safe-slice.js';

import type { ToolDefinition } from '../types/events.js';
import type {
  GateConfig,
  GatePolicy,
  GatePolicyMatch,
  GateBehavior,
  GateDecision,
  GateEntryRef,
  WakeLine,
  GateEventInfo,
  GatePolicyStats,
  GateStatus,
  ShadowWarning,
  GateProbeRow,
} from './types.js';

// Re-export types consumers need
export type { GateConfig, GateOptions, GateDecision, GateEntryRef, GateEventInfo, WakeLine } from './types.js';

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

/**
 * Parse a gate file's text as JSON. Some Windows editors save UTF-8 with a
 * leading U+FEFF (BOM), which `readFileSync(…, 'utf-8')` keeps and
 * `JSON.parse` rejects; drop exactly one before parsing (#395).
 */
function parseGateJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
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
  /** The event's own identity among what the framework stored at arrival:
   *  a channel message's id, a push event's event id (isNewestEntry). */
  messageId?: string;
  eventId?: string;
}

/** Where the host put a message the gate wrote: the agent whose window it
 *  went to and, when it was held for that agent's live turn, the id it waits
 *  under in the host's queue. */
export interface WritePlacement {
  agent?: string;
  deferredId?: string;
}

/**
 * Where a gate-requested wake came from, handed to the framework alongside the
 * reason so the turn's InferenceRequest can carry it (host telemetry stamps
 * "who woke the agent" from it). Ids only, never content or display names,
 * except `line`, which is the batch's own text for the agent's window.
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
  /** The server of `routeChannelId`'s channel, beside it whenever the chosen
   *  event named its server: channel ids are unique only within one
   *  server's connection (MCPL §14.2). */
  routeServerId?: string;
  /** Timestamp (ms) of the chosen event, so a consumer coalescing several
   *  requests can order by event recency, not by flush order. */
  at?: number;
  /** The batch's `[Gate: …]` line, when the gate handed it to the wake rather
   *  than wrote it: a WakeLine, the parts its text is rendered from when it's
   *  written (wakeLineText), decided by a fresh start of the wake's turn as
   *  WakeLine says. Unlike the fields above, this is content for the agent's
   *  window, not telemetry: it carries the channel's name as the agent is
   *  shown it. */
  line?: WakeLine;
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
    ...(pick.addressed && pick.routeChannelId
      ? { routeChannelId: pick.routeChannelId, ...(pick.serverId ? { routeServerId: pick.serverId } : {}) }
      : {}),
    at: pick.timestamp,
  };
}

/** A `[Gate: …]` line's reference to messages already in the window: how
 *  many, in which channel, and how long ago the oldest arrived, as of `now`. */
function referenceLine(count: number, channel: string, oldest: number, now: number): string {
  const age = Math.round((now - oldest) / 1000);
  return `- ${count} message${count > 1 ? 's' : ''} in ${channel} ` +
    `(oldest ~${age}s ago) — already shown above at arrival; this is a ` +
    `batched wake, not new content`;
}

/** A handed batched-wake line's text (WakeLine), as it reads when written at
 *  `now`: the gate's words, its message's age counted to then. */
export function wakeLineText(line: WakeLine, now: number): string {
  return `[Gate: 1 event matched]\n\n${referenceLine(1, line.shown, line.at, now)}`;
}

/** The event's own stored entry, as the framework is asked about it. */
function entryRef(event: PendingEvent): GateEntryRef {
  return {
    eventType: event.eventType,
    ...(event.serverId !== undefined ? { serverId: event.serverId } : {}),
    ...(event.channelId !== undefined ? { channelId: event.channelId } : {}),
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
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
// Reading rules
// ---------------------------------------------------------------------------

// A rule is read as written when it can be, and every problem it has is named.
// gate.json and the host's starting rules are what a deployment already runs,
// so a rule with a problem is read the way earlier releases read it, and no
// event that woke the agent there goes quiet: a behavior the gate doesn't know
// is read as "always"; a field of the wrong type, one slip from one the gate
// reads there, or one the gate reads at another level of the rule (a match's
// "tagsAny" beside "name"), as left out, its problem naming where it's read;
// and a number out of range the way the starting rules ran it, but for a
// debounce, read at its nearest bound, which can send a batch later or sooner
// but drops no event in it, and a refill interval of 0, read as refilling at
// once. A rule is left out only where earlier releases refused it. One that
// skips or defers is read past a problem too, holding back what they held back:
// left out, the events it held back would go on to the rules after it, where a
// rate limit, a sample or a debounce could spend them and then hold back an
// event that woke the agent before. Under a default that holds events back, a
// file that leaves out a rule that could wake the agent isn't used, since that
// would hold back what the rule was written to wake on; earlier releases didn't
// use it either. A change through addPolicy, whose caller is there to fix it,
// refuses any problem, and nothing is saved. A field name that is no slip of
// one the gate reads there, and that it reads at no other level, changes
// nothing, a slip of another level's field included: it loads, and a note names
// it with the fields its place holds. In a rule, a name holding a field's whole
// name is such a name beside that field, an extra that explains it, and a slip
// of the field where it's given in the field's place (fieldNames); at
// gate.json's top, where it can be a label of the file, it's such a name either
// way. A file earlier releases loaded loads as they read it: a slip of
// "policies", a list of rules parked under a name the gate doesn't read, a
// rule's fields at gate.json's top and a "policies" that isn't a list each do
// nothing, and a note names each, so where "policies" writes no rules the file
// has none, and under "skip" or "defer" it holds back every event, as it did. A
// "policies" holding nothing writes no rules, as one left out does. A null is a
// field left out, and so is "", with a note: earlier releases read most fields
// that way, and none narrows anything by them. Where they refused a rule or a
// file for a null or a "" (a passthrough, a behavior's kind, gate.json's
// default), it now loads without it.

const CONFIG_FIELDS = ['default', 'policies'];
const POLICY_FIELDS = ['name', 'match', 'behavior', 'resets', 'passthrough'];
const MATCH_FIELDS = [
  'scope', 'source', 'channel', 'mount', 'pathGlob', 'tagsAny', 'tagsAll', 'tagsNone', 'metadataTrue', 'filter',
];
const FILTER_FIELDS = ['type', 'pattern'];
const BEHAVIOR_KINDS = ['debounce', 'rate_limit', 'passive_sample'] as const;
const RATE_LIMIT_FIELDS = ['tokens', 'refillIntervalMs', 'keyBy'];
const PASSIVE_SAMPLE_FIELDS = ['every', 'keyBy'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A value that sets nothing: null, "", an empty list, or an object holding only such values. */
function holdsNothing(value: unknown): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0)
    || (isPlainObject(value) && Object.values(value).every(holdsNothing));
}

/**
 * Whether a failed write left its file as it was: writeFileSync reports a
 * failure once it has the file open, so it may have changed it, as its write
 * or its close.
 */
function beforeWriting(err: unknown): boolean {
  const syscall = (err as NodeJS.ErrnoException).syscall;
  return syscall !== 'write' && syscall !== 'close';
}

/**
 * A change's refusal where gate.json has no rule list it could edit without
 * writing over what it holds: a list, JSON that isn't an object, or a
 * "policies" that isn't a list and holds something. `runs` is what the gate
 * runs meanwhile (rulesRun).
 */
function noListRefusal(noList: string, runs: string): string {
  return `${noList}, so it has no list of rules a change could edit without writing over what it holds, and nothing `
    + `was saved. Meanwhile the gate runs ${runs}. Until gate.json is an object whose "policies" is a list holding its `
    + 'rules, a change is refused the same way.';
}

/**
 * A change's refusal where gate.json is there but couldn't be used as a file
 * a change edits: it couldn't be read, or it isn't JSON (`notJson`). Nothing is
 * written over it, so what it holds, often an operator's unfinished edit, stays
 * as it is. `runs` is what the gate runs meanwhile (rulesRun).
 */
function unusableRefusal(unusable: { error: string; notJson?: true }, runs: string): string {
  if (!unusable.notJson) {
    return `gate.json couldn't be read (${unusable.error}), so a change can't edit it, and nothing was written over it. `
      + `Meanwhile the gate runs ${runs}. Whoever runs this host can make gate.json readable; until then, a change is `
      + 'refused the same way.';
  }
  return `gate.json isn't JSON the gate can read (${unusable.error}), so a change can't edit its rules without writing `
    + `over what it holds, and nothing was saved. Meanwhile the gate runs ${runs}. Until gate.json is JSON, a change is `
    + 'refused the same way.';
}

/**
 * A change's refusal at a start that didn't use gate.json, which has no rules
 * of its own (start-without): a change puts the rules gate.json then holds in
 * force, so it would take out of force what the start runs in its place.
 * `runs` is what the gate runs meanwhile (rulesRun); gate_status's entries
 * (notUsedClause, describeStart) say which rules keep gate.json out of use
 * and each fix.
 */
function notUsedRefusal(runs: string): string {
  return "gate.json isn't used at this start, which runs as one without it does, and a change would put gate.json's rules in "
    + `force in place of what that runs, so nothing was saved. Meanwhile the gate runs ${runs}. gate_status says what keeps `
    + 'gate.json out of use and what would put it in use, such as giving it rules under "policies", or fixing the starting '
    + 'rules, which whoever runs this host can do, for the next start; until then, a change is refused the same way.';
}

/**
 * A value as a message quotes it: its JSON, cut short when long, never inside a
 * surrogate pair, since the message reaches the agent's context.
 */
export function shownValue(value: unknown): string {
  if (value === undefined) return 'missing';
  // JSON writes NaN and the infinities as null.
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > 80 ? `${safeSlice(json, 0, 77)}...` : json;
}

/** Entries of a list as a message quotes them. */
function shownValues(values: readonly unknown[]): string {
  return values.map(shownValue).join(', ');
}

/** `a`, `a and b`, `a, b and c` (or "or"). */
function joinedList(items: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"` (or "or"). */
function quotedList(names: readonly string[], joiner: 'and' | 'or' = 'and'): string {
  return joinedList(names.map((n) => `"${n}"`), joiner);
}

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** A message part as one sentence, for joining several. */
function sentence(text: string): string {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

/** How a note speaks of what it checks: a rule's fields, or a tool's parameters. */
const RULE_FIELDS_TERMS = { unread: "which the gate doesn't read", listed: 'Its fields are' };
const TOOL_PARAMETERS_TERMS = { unread: "which it doesn't take", listed: 'Its parameters are' };

/** A field name one slip from one or more the gate reads in its place. */
interface Slip {
  key: string;
  /** Every field it could be meant for, in closestNames' order: `tags` is part of "tagsAny", "tagsAll" and "tagsNone". */
  meant: string[];
}

/**
 * An object's field names that the gate doesn't read in its place: slips of
 * one it does, and the rest. A name is a slip of each field isNearMiss finds
 * it close to and, where `held`, of each whose whole name it holds, ignoring
 * case, that the object doesn't give: sent in that field's place, it's the
 * field under another name (`matchTags` with no `match`), where beside it,
 * it's an extra. The object is one withoutEmpty read, so a field given as
 * null or "" isn't given.
 */
function fieldNames(
  obj: Record<string, unknown>, fields: readonly string[], held = true,
): { slips: Slip[]; unread: string[] } {
  const slips: Slip[] = [];
  const unread: string[] = [];
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || fields.includes(key)) continue;
    // Every field the gate reads has four characters or more, so holding one
    // needs no length of its own here. A field of two characters or fewer
    // would be held by names that have nothing to do with it ("valid" holds
    // "id"), and holding it would need the three characters isNearMiss asks
    // of a part.
    const holds = (field: string): boolean => key.toLowerCase().includes(field.toLowerCase());
    const near = fields.filter((field) => isNearMiss(key, field) || (held && !Object.hasOwn(obj, field) && holds(field)));
    if (near.length === 0) {
      unread.push(key);
      continue;
    }
    // closestNames keeps every name decided on above, in its order.
    slips.push({ key, meant: closestNames(key, near, near.length) });
  }
  return { slips, unread };
}

/** `"tags" (did you mean "tagsAny", "tagsAll" or "tagsNone"?)` */
function slipShown(slip: Slip): string {
  return `"${slip.key}" (did you mean ${quotedList(slip.meant, 'or')}?)`;
}

/** Names an object has that are fields read at another level, with where that is (`homes`). */
interface Misplaced {
  keys: string[];
  homes: string[];
}

/**
 * An object's names that do nothing in its place, split into those that are
 * fields read elsewhere, grouped by where (`homesOf`), and the rest.
 */
function placedElsewhere(
  unread: readonly string[], homesOf: (key: string) => string[],
): { misplaced: Misplaced[]; rest: string[] } {
  const misplaced: Misplaced[] = [];
  const rest: string[] = [];
  for (const key of unread) {
    const homes = homesOf(key);
    if (homes.length === 0) {
      rest.push(key);
      continue;
    }
    const same = misplaced.find((m) => m.homes.join() === homes.join());
    if (same) same.keys.push(key);
    else misplaced.push({ keys: [key], homes });
  }
  return { misplaced, rest };
}

/** `"tagsAny", a field of "match"`; `"tagsAny" and "source", fields of "match"` */
function misplacedShown(m: Misplaced): string {
  return `${quotedList(m.keys)}, ${m.keys.length === 1 ? 'a field' : 'fields'} of ${joinedList(m.homes)}`;
}

/**
 * The levels of a gate.json the gate reads fields at, each as a message names
 * it, `file` naming the file itself.
 */
function fieldLevels(file: string): ReadonlyArray<{ name: string; fields: readonly string[] }> {
  return [
    { name: file, fields: CONFIG_FIELDS },
    { name: 'a rule', fields: POLICY_FIELDS },
    { name: '"match"', fields: MATCH_FIELDS },
    { name: '"match.filter"', fields: FILTER_FIELDS },
    { name: '"behavior"', fields: BEHAVIOR_KINDS },
    { name: '"behavior.rate_limit"', fields: RATE_LIMIT_FIELDS },
    { name: '"behavior.passive_sample"', fields: PASSIVE_SAMPLE_FIELDS },
  ];
}

/** Where a name is a field the gate reads, at a level other than the one whose fields are `here`. */
function homesOf(file: string, here: readonly string[]): (key: string) => string[] {
  return (key) => fieldLevels(file)
    .filter((level) => level.fields !== here && level.fields.includes(key))
    .map((level) => level.name);
}

/** Where each field of an object schema's nested objects is taken: `tagsAny` in "match". */
function nestedFields(properties: Readonly<Record<string, unknown>>, path = ''): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  const add = (field: string, where: string) => homes.set(field, [...(homes.get(field) ?? []), where]);
  for (const [name, schema] of Object.entries(properties)) {
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) continue;
    const where = path ? `${path}.${name}` : name;
    for (const field of Object.keys(schema.properties)) add(field, `"${where}"`);
    for (const [field, inner] of nestedFields(schema.properties, where)) for (const at of inner) add(field, at);
  }
  return homes;
}

/** A note naming the fields an object has that do nothing in its place, with the fields that do. */
function noteUnread(
  where: string, unread: readonly string[], fields: readonly string[], notes: string[], terms = RULE_FIELDS_TERMS,
): void {
  if (unread.length === 0) return;
  notes.push(
    `${where} has ${quotedList(unread)}, ${terms.unread}, so ${unread.length === 1 ? 'it does' : 'they do'} `
    + `nothing. ${terms.listed} ${quotedList(fields)}.`,
  );
}

/**
 * A tool's input, its parameters given by its schema's `properties`, read as a
 * rule's fields are: a null or "" parameter is left out (a note names each "",
 * with what leaving it out does where `means` says), a slip of a parameter
 * (fieldNames) is refused, naming the one meant, and so is a field of one of
 * its object parameters given on its own, naming that parameter; any other
 * name is noted, or named in that refusal. Returns the input without what was
 * left out.
 */
export function checkToolInput(
  tool: string, input: Record<string, unknown>, properties: Readonly<Record<string, unknown>>, notes: string[],
  means: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const params = Object.keys(properties);
  const given = withoutEmpty(tool, input, notes, means);
  const { slips, unread } = fieldNames(given, params);
  const homes = nestedFields(properties);
  const { misplaced, rest } = placedElsewhere(unread, (key) => homes.get(key) ?? []);
  if (slips.length > 0 || misplaced.length > 0) {
    // Every name it doesn't take is named, so the call that follows the refusal doesn't count on one.
    const has = [
      ...(slips.length > 0 ? [`${slips.map(slipShown).join(' and ')}, ${TOOL_PARAMETERS_TERMS.unread}`] : []),
      ...misplaced.map((m) => `${misplacedShown(m)}, ${TOOL_PARAMETERS_TERMS.unread} here`),
      ...(rest.length > 0 ? [`${quotedList(rest)}, ${TOOL_PARAMETERS_TERMS.unread}`] : []),
    ];
    // Where a field has one home, show it there, as the call would give it. A
    // value shownValue cuts short isn't one the call could give, so then the
    // parameter is named alone.
    const moves = misplaced.filter((m) => m.homes.length === 1).map((m) => {
      const it = m.keys.length === 1 ? 'it' : 'them';
      const shown = m.keys.map((key) => [key, shownValue(given[key])] as const);
      return shown.every(([key, value]) => value === JSON.stringify(given[key]))
        ? `Put ${it} in ${m.homes[0]}: {${shown.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')}}.`
        : `Put ${it} in ${m.homes[0]}.`;
    });
    throw new Error(
      `${tool} has ${has.join(', and ')}, so nothing was saved. ${moves.map((move) => `${move} `).join('')}`
      + `${TOOL_PARAMETERS_TERMS.listed} ${quotedList(params)}.`,
    );
  }
  noteUnread(tool, rest, params, notes, TOOL_PARAMETERS_TERMS);
  return given;
}

/**
 * An object's fields as the gate reads them: a null or "" is a field left out,
 * and a note names each "", with what leaving it out does where that's more
 * than setting no constraint (`means`, by field). Every other field stays an
 * own field of the copy, "__proto__" included, which JSON gives as one: set by
 * assignment, it would make its value the copy's prototype, whose fields the
 * gate would then read as the object's own.
 */
function withoutEmpty(
  where: string, obj: Record<string, unknown>, notes: string[], means: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const kept: Array<[string, unknown]> = [];
  const empty: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (value === '') empty.push(key);
    else kept.push([key, value]);
  }
  const out: Record<string, unknown> = Object.fromEntries(kept);
  if (empty.length > 0) {
    const meant = empty.flatMap((key) => {
      // An own field only: a name such as "constructor" would find Object.prototype's.
      const what = Object.hasOwn(means, key) ? means[key] : undefined;
      return what ? [what] : [];
    });
    notes.push(
      `${where} has ${quotedList(empty)} as "", so ${empty.length === 1 ? "it's" : "they're"} left out`
      + `${meant.length > 0 ? `: ${meant.join(', and ')}` : ''}.`,
    );
  }
  return out;
}

/** What leaving out a rule's field does, where that's more than setting no constraint. */
const RULE_LEFT_OUT = { behavior: 'a rule without one has the behavior "always"', match: 'a rule without one matches every event' };
/** The same for gate.json's own fields, under the default it then has. */
function configLeftOut(defaultBehavior: unknown): Record<string, string> {
  return {
    default: 'its default is "always"',
    policies: defaultBehavior === 'skip' || defaultBehavior === 'defer'
      ? `it has no rules, so under its default, "${defaultBehavior}", every event is held back`
      : 'it has no rules, so every event gets the default, "always"',
  };
}

/** A problem a rule has. */
interface RuleProblem {
  /** What's wrong: the field, what it holds, and what's needed. */
  text: string;
  /** How the rule is read past it ("so …"), the way earlier releases read it.
   *  Absent where they refused the rule, which is then left out. */
  read?: string;
  /** The reading only narrows what the rule matches (an empty scope entry),
   *  so a rule that holds events back holds back no more for it. */
  narrows?: boolean;
}

/** A rule as the gate reads it. */
interface RuleReading {
  /** How messages name it: `Policy "x"`, or its place when it has no name. */
  where: string;
  /** The rule as read, unless a problem has no reading. */
  policy?: GatePolicy;
  /** It wakes on none of what it matches, even where it can't be read: it
   *  skips or defers, or it's a rate limit whose tokens are a number not over
   *  0. Left out, such a rule holds back nothing it was written to wake on,
   *  though what it matches goes on to the rules after it, as for any rule
   *  left out. */
  quiet: boolean;
  /** Every problem it has, in the order its fields are read. */
  problems: RuleProblem[];
  /** Its fields that do nothing, and those given as "", each a sentence. */
  notes: string[];
  /** Set where it would be in force, and nothing left in its match narrows it. */
  matchesAll?: boolean;
}

/**
 * A rule's notes, ending with what a match that narrows nothing does. A
 * refusal says it of the rule read without what's wrong in its match, as
 * earlier releases read it, since that's why what's wrong there matters.
 */
function notesOf(reading: RuleReading, refused = false): string[] {
  if (!reading.matchesAll) return reading.notes;
  return [...reading.notes, refused
    ? "Read without what's wrong in its match, as earlier releases read it, the rule would match every event."
    : `${reading.where}: nothing left in match narrows the rule, so it matches every event.`];
}

/** Where a rule's fields are read into: the rule's name in messages, its problems, and its notes. */
interface Reader {
  where: string;
  /** How messages name the file the rule is in, for a field of the file's own put in the rule. */
  file: string;
  problems: RuleProblem[];
  notes: string[];
  /** Set where its rate limit's tokens are a number not over 0, so it wakes on none of what it matches. */
  noTokens?: boolean;
  /** Set where its match is left with nothing that narrows it, once something in it was named. */
  matchesAll?: boolean;
}

/** How a slip is read: as a field left out, which does nothing. */
const SLIP_READ = 'so it does nothing';
/** How a field of the wrong type is read: as one left out. */
const DROPPED = 'so the rule is read without it';

/**
 * An object's field names, at `level` of the rule (such as "match"): a slip of
 * a field is a problem, read as the field left out, and so is a field the gate
 * reads at another level, named with where that is (`misplacedReadOf` says
 * how the rule then reads, where that's more than the field doing nothing);
 * any other name the gate doesn't read is noted.
 */
function readFieldNames(
  r: Reader, level: string | null, obj: Record<string, unknown>, fields: readonly string[],
  readOf: (slip: Slip) => string = () => SLIP_READ,
  misplacedReadOf: (m: Misplaced) => string | undefined = () => undefined,
): void {
  const { slips, unread } = fieldNames(obj, fields);
  const { misplaced, rest } = placedElsewhere(unread, homesOf(r.file, fields));
  noteUnread(level ? `${r.where}: ${level}` : r.where, rest, fields, r.notes);
  for (const slip of slips) {
    r.problems.push({ text: `${level ?? 'it'} has ${slipShown(slip)}, which the gate doesn't read`, read: readOf(slip) });
  }
  for (const m of misplaced) {
    r.problems.push({
      text: `${level ?? 'it'} has ${misplacedShown(m)}, which the gate doesn't read here`,
      read: misplacedReadOf(m) ?? (m.keys.length === 1 ? SLIP_READ : 'so they do nothing'),
    });
  }
}

/** "so that entry is dropped", "so those entries are dropped". */
function droppedEntries(count: number): string {
  return count === 1 ? 'so that entry is dropped' : 'so those entries are dropped';
}

/**
 * A rule, read as written, or past each problem it has. `unnamed` names a rule
 * without a name in messages, and `file` the file it's in.
 */
function readRule(raw: unknown, unnamed: string, file = 'gate.json'): RuleReading {
  if (!isPlainObject(raw)) {
    return {
      where: unnamed,
      problems: [{ text: `it's ${shownValue(raw)}, where a rule is an object, such as {"name": "my-rule", "behavior": "always"}` }],
      notes: [],
      quiet: false,
    };
  }
  const name = nameOf(raw);
  const r: Reader = { where: name ? `Policy "${name}"` : unnamed, file, problems: [], notes: [] };
  const obj = withoutEmpty(r.where, raw, r.notes, RULE_LEFT_OUT);
  // Field names first, so a slip of one is named before what its absence does.
  readFieldNames(r, null, obj, POLICY_FIELDS, (slip) => {
    if (slip.meant.includes('behavior') && obj.behavior === undefined) return 'so the rule\'s behavior is "always"';
    if (slip.meant.includes('match') && obj.match === undefined) return 'so the rule matches every event';
    return SLIP_READ;
  }, (m) => {
    const of = (fields: readonly string[]) => m.keys.some((key) => fields.includes(key));
    if (obj.match === undefined && (of(MATCH_FIELDS) || of(FILTER_FIELDS))) return 'so the rule matches every event';
    if (obj.behavior === undefined && (of(BEHAVIOR_KINDS) || of(RATE_LIMIT_FIELDS) || of(PASSIVE_SAMPLE_FIELDS))) {
      return 'so the rule\'s behavior is "always"';
    }
    return undefined;
  });
  if (!name) {
    r.problems.push({
      text: obj.name === undefined ? 'it has no "name"' : `name is ${shownValue(obj.name)}, where a non-empty string is needed`,
    });
  }
  const { behavior, kind } = readBehavior(r, obj.behavior);
  const match = readMatch(r, obj.match);
  const resets = readResets(r, obj.resets);
  const passthrough = readPassthrough(r, obj.passthrough, behavior, kind);
  const reading: RuleReading = {
    where: r.where, problems: r.problems, notes: r.notes, quiet: kind === 'skip' || kind === 'defer' || r.noTokens === true,
  };
  if (name && behavior && r.problems.every((p) => p.read !== undefined)) {
    const policy: GatePolicy = { name, match, behavior };
    if (resets) policy.resets = resets;
    if (passthrough) policy.passthrough = true;
    reading.policy = policy;
    if (r.matchesAll) reading.matchesAll = true;
  }
  return reading;
}

type BehaviorKind = 'always' | 'defer' | 'skip' | (typeof BEHAVIOR_KINDS)[number];

const BEHAVIORS_NEEDED = '"always", "defer" or "skip", or an object holding one of "debounce", "rate_limit" and "passive_sample"';

/**
 * A rule's behavior: "always" when left out; one of the three names; or an
 * object holding one of the timing kinds. Anything else but a list or an
 * object was read as "always", a rule that wakes on every event it matches,
 * and is read so; a list, or an object holding none of the kinds, was
 * refused, and the rule is left out. Of
 * two kinds or more, "debounce", then "rate_limit", then "passive_sample" was
 * the one read, whatever their order, and is read so. Each other kind is read
 * on its own as well, so that a refusal names its problems too, and a load
 * reads past them, since it isn't read either way. `kind` is the behavior's
 * kind even where it can't be read, for passthrough's check.
 */
function readBehavior(r: Reader, value: unknown): { behavior?: GateBehavior | undefined; kind?: BehaviorKind | undefined } {
  if (value === undefined) return { behavior: 'always', kind: 'always' };
  if (value === 'always' || value === 'defer' || value === 'skip') return { behavior: value, kind: value };
  if (!isPlainObject(value)) {
    if (Array.isArray(value)) {
      r.problems.push({ text: `behavior is ${shownValue(value)}, where ${BEHAVIORS_NEEDED} is needed` });
      return {};
    }
    r.problems.push({ text: `behavior is ${shownValue(value)}, where ${BEHAVIORS_NEEDED} is needed`, read: 'so it\'s read as "always"' });
    return { behavior: 'always', kind: 'always' };
  }
  const b = withoutEmpty(`${r.where}: behavior`, value, r.notes);
  readFieldNames(r, 'behavior', b, BEHAVIOR_KINDS);
  const kinds = BEHAVIOR_KINDS.filter((k) => b[k] !== undefined);
  const kind = kinds[0];
  if (kind === undefined) {
    r.problems.push({ text: 'behavior holds none of "debounce", "rate_limit" and "passive_sample"' });
    return {};
  }
  if (kinds.length > 1) {
    r.problems.push({ text: `behavior holds ${quotedList(kinds)}, and a rule has one behavior`, read: `so only its "${kind}" is read` });
  }
  const behavior = READ_KIND[kind](r, b[kind]);
  for (const other of kinds.slice(1)) {
    const unread: Reader = { where: r.where, file: r.file, problems: [], notes: [] };
    READ_KIND[other](unread, b[other]);
    for (const p of unread.problems) r.problems.push({ text: p.text, read: `which goes unread with the rest of "${other}"` });
  }
  return { behavior, kind };
}

/**
 * A debounce: a number of milliseconds. One out of the gate's range is read
 * at its nearest bound. Earlier releases refused it in gate.json and ran it
 * as written in the starting rules, where one over 2,147,483,647 ms ran after
 * 1 ms, the most a timer takes; read at the bound, a batch goes out later or
 * sooner than it did there, and every event in it is still delivered.
 */
function readDebounce(r: Reader, ms: unknown): GateBehavior | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    r.problems.push({ text: `behavior.debounce is ${shownValue(ms)}, where a number of milliseconds is needed, such as 60000` });
    return undefined;
  }
  if (ms < MIN_DEBOUNCE_MS) {
    r.problems.push({
      text: `behavior.debounce is ${ms} ms, under the ${MIN_DEBOUNCE_MS} ms minimum`, read: `so it's read as ${MIN_DEBOUNCE_MS} ms`,
    });
    return { debounce: MIN_DEBOUNCE_MS };
  }
  if (ms > MAX_DEBOUNCE_MS) {
    r.problems.push({
      text: `behavior.debounce is ${ms} ms, over the ${MAX_DEBOUNCE_MS} ms maximum`, read: `so it's read as ${MAX_DEBOUNCE_MS} ms`,
    });
    return { debounce: MAX_DEBOUNCE_MS };
  }
  return { debounce: ms };
}

/**
 * A rate limit. A refill interval under 0 ran as a bucket that never refills,
 * waking on its first tokens and then on none of what the rule matched, and
 * is read so. One of 0 refilled the bucket once and then never, its clock left
 * at NaN; it's read as refilling at once, every time, so the rule limits
 * nothing, which holds back nothing it woke the agent on (applyRateLimit). A
 * rule whose tokens aren't a positive number is left out, as earlier releases'
 * check refused it. Tokens that are a number not over 0, which ran unchecked
 * from the starting rules, woke the agent on nothing the rule matched, so that
 * rule is quiet (noTokens): leaving it out holds back nothing it was written
 * to wake on, though what it matches goes on to the rules after it, as for any
 * rule left out.
 */
function readRateLimit(r: Reader, value: unknown): GateBehavior | undefined {
  if (!isPlainObject(value)) {
    r.problems.push({
      text: `behavior.rate_limit is ${shownValue(value)}, where an object is needed, such as {"tokens": 3, "refillIntervalMs": 60000}`,
    });
    return undefined;
  }
  const conf = withoutEmpty(`${r.where}: behavior.rate_limit`, value, r.notes, { keyBy: 'every event the rule matches shares one bucket' });
  readFieldNames(r, 'behavior.rate_limit', conf, RATE_LIMIT_FIELDS);
  const tokens = conf.tokens;
  const refill = conf.refillIntervalMs;
  const tokensUsable = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0;
  if (typeof tokens === 'number' && !(tokens > 0)) r.noTokens = true;
  if (!tokensUsable) {
    r.problems.push({ text: `behavior.rate_limit.tokens is ${shownValue(tokens)}, where a positive number is needed` });
  }
  const refillUsable = typeof refill === 'number' && Number.isFinite(refill);
  if (!refillUsable) {
    r.problems.push({
      text: `behavior.rate_limit.refillIntervalMs is ${shownValue(refill)}, where a positive number of milliseconds is needed`,
    });
  } else if (refill <= 0) {
    r.problems.push({
      text: `behavior.rate_limit.refillIntervalMs is ${refill}, where a positive number of milliseconds is needed`,
      read: refill === 0
        ? 'so its tokens refill at once, and it limits nothing it matches'
        : "so its tokens never refill, and once they're spent it wakes the agent on nothing it matches",
    });
  }
  const keyBy = readKeyBy(r, 'rate_limit', conf.keyBy);
  if (!tokensUsable || !refillUsable) return undefined;
  const out: { tokens: number; refillIntervalMs: number; keyBy?: string } = { tokens, refillIntervalMs: refill };
  if (keyBy !== undefined) out.keyBy = keyBy;
  return { rate_limit: out };
}

/**
 * A sample. A step at or under 0 sampled every event, as 1 does, and a
 * fraction its next whole number, since the count was compared with it, so
 * each is read that way.
 */
function readPassiveSample(r: Reader, value: unknown): GateBehavior | undefined {
  if (!isPlainObject(value)) {
    r.problems.push({ text: `behavior.passive_sample is ${shownValue(value)}, where an object is needed, such as {"every": 10}` });
    return undefined;
  }
  const conf = withoutEmpty(`${r.where}: behavior.passive_sample`, value, r.notes, { keyBy: 'every event the rule matches shares one count' });
  readFieldNames(r, 'behavior.passive_sample', conf, PASSIVE_SAMPLE_FIELDS);
  const given = conf.every;
  let every: number | undefined;
  if (typeof given !== 'number' || !Number.isFinite(given)) {
    r.problems.push({ text: `behavior.passive_sample.every is ${shownValue(given)}, where a whole number of 1 or more is needed` });
  } else if (Number.isInteger(given) && given > 0) {
    every = given;
  } else {
    every = given <= 0 ? 1 : Math.ceil(given);
    r.problems.push({
      text: `behavior.passive_sample.every is ${given}, ${given <= 0 ? 'under 1' : 'not a whole number'}`,
      read: `so it's read as ${every}`,
    });
  }
  const keyBy = readKeyBy(r, 'passive_sample', conf.keyBy);
  if (every === undefined) return undefined;
  const out: { every: number; keyBy?: string } = { every };
  if (keyBy !== undefined) out.keyBy = keyBy;
  return { passive_sample: out };
}

/** How each kind of behavior object is read. */
const READ_KIND: Readonly<Record<(typeof BEHAVIOR_KINDS)[number], (r: Reader, value: unknown) => GateBehavior | undefined>> = {
  debounce: readDebounce,
  rate_limit: readRateLimit,
  passive_sample: readPassiveSample,
};

/** A timing kind's keyBy: a field name. One of another type was read as none. */
function readKeyBy(r: Reader, kind: 'rate_limit' | 'passive_sample', value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  r.problems.push({
    text: `behavior.${kind}.keyBy is ${shownValue(value)}, where a field name is needed, such as "channelId"`,
    read: `so it does nothing, and every event the rule matches shares one ${kind === 'rate_limit' ? 'bucket' : 'count'}`,
  });
  return undefined;
}

/**
 * A rule's match: every field optional, and one left out matches anything. A
 * field of the wrong type, or an entry of one in a list, was dropped, which
 * widened the rule, and is read so; an empty entry in a list, dropped, but for
 * one in `scope`, which was kept and narrows the rule, since no event's type is
 * "". A match that isn't an object matched every event, and so does one left
 * with nothing that narrows it, which readRule notes, for a rule it can read,
 * where something in the match was named: dropped, left out or unread.
 */
function readMatch(r: Reader, value: unknown): GatePolicyMatch {
  const match: GatePolicyMatch = {};
  if (value === undefined) return match;
  if (!isPlainObject(value)) {
    r.problems.push({
      text: `match is ${shownValue(value)}, where an object is needed, such as {"source": "discord"}`,
      read: 'so the rule matches every event',
    });
    return match;
  }
  const named = r.problems.length + r.notes.length;
  const m = withoutEmpty(`${r.where}: match`, value, r.notes);
  readFieldNames(r, 'match', m, MATCH_FIELDS);

  if (m.scope !== undefined) {
    if (!Array.isArray(m.scope)) {
      r.problems.push({
        text: `match.scope is ${shownValue(m.scope)}, where a list of event types is needed, such as ["mcpl:channel-incoming"]`,
        read: 'so the rule matches every type of event',
      });
    } else {
      const types = m.scope.filter((s): s is string => typeof s === 'string');
      const dropped = m.scope.filter((s) => typeof s !== 'string');
      if (dropped.length > 0) {
        r.problems.push({
          text: `match.scope holds ${shownValues(dropped)}, which ${dropped.length === 1 ? "isn't an event type" : "aren't event types"}`,
          read: types.length > 0 ? droppedEntries(dropped.length) : `${droppedEntries(dropped.length)}, and the rule matches every type of event`,
        });
      }
      if (types.includes('')) {
        r.problems.push({
          text: 'match.scope holds "", and no event\'s type is ""',
          read: types.every((t) => t === '') ? 'so the rule matches no event' : 'so that entry matches no event',
          narrows: true,
        });
      }
      match.scope = types;
    }
  }
  for (const [field, example] of [
    ['source', '"discord"'], ['channel', '"discord:*:12345"'], ['mount', '"project"'], ['pathGlob', '"notes/*.md"'],
  ] as const) {
    const given = m[field];
    if (given === undefined) continue;
    if (typeof given === 'string') match[field] = given;
    else r.problems.push({ text: `match.${field} is ${shownValue(given)}, where a string is needed, such as ${example}`, read: DROPPED });
  }
  for (const [field, example] of [
    ['metadataTrue', '["mentioned"]'], ['tagsAny', '["chat:ambient"]'], ['tagsAll', '["chat:ambient"]'], ['tagsNone', '["chat:ambient"]'],
  ] as const) {
    const given = m[field];
    if (given === undefined) continue;
    if (!Array.isArray(given)) {
      r.problems.push({
        text: `match.${field} is ${shownValue(given)}, where a list of non-empty strings is needed, such as ${example}`, read: DROPPED,
      });
      continue;
    }
    const kept = given.filter((s): s is string => typeof s === 'string' && s.length > 0);
    const dropped = given.filter((s) => typeof s !== 'string' || s.length === 0);
    if (dropped.length > 0) {
      r.problems.push({
        text: `match.${field} holds ${shownValues(dropped)}, where each entry is a non-empty string`,
        read: kept.length > 0 ? droppedEntries(dropped.length) : `${droppedEntries(dropped.length)}, and with none left the list narrows nothing`,
      });
    }
    if (kept.length > 0) match[field] = kept;
  }

  if (m.filter !== undefined) {
    if (!isPlainObject(m.filter)) {
      r.problems.push({
        text: `match.filter is ${shownValue(m.filter)}, where an object is needed, such as {"type": "text", "pattern": "release"}`,
        read: DROPPED,
      });
    } else {
      // An empty pattern matches every event's content, so a filter with one
      // narrows nothing, as before, and it's left out, its other problems named.
      const emptyPattern = m.filter.pattern === '';
      const f = withoutEmpty(`${r.where}: match.filter`, emptyPattern ? { ...m.filter, pattern: undefined } : m.filter, r.notes);
      readFieldNames(r, 'match.filter', f, FILTER_FIELDS);
      const without = 'so the rule is read without its filter';
      const type = f.type === 'text' || f.type === 'regex' ? f.type : undefined;
      if (type === undefined) {
        r.problems.push({ text: `match.filter.type is ${shownValue(f.type)}, where "text" or "regex" is needed`, read: without });
      }
      if (emptyPattern) {
        r.notes.push(`${r.where}: match.filter's pattern is "", so the filter narrows nothing, and it's left out.`);
      } else if (typeof f.pattern !== 'string') {
        r.problems.push({
          text: `match.filter.pattern is ${shownValue(f.pattern)}, where the text or regular expression to look for is needed`,
          read: without,
        });
      } else if (type === 'text') {
        match.filter = { type, pattern: f.pattern };
      } else if (type === 'regex') {
        try {
          new RegExp(f.pattern);
          match.filter = { type, pattern: f.pattern };
        } catch (e) {
          r.problems.push({ text: `match.filter.pattern isn't a regular expression the gate can read (${errorText(e)})` });
        }
      }
    }
  }

  // Left with nothing that narrows it once something in it was named, it
  // matches every event. Empty lists and nulls alone always meant no
  // constraint, and name nothing.
  const narrows = Object.entries(match).some(([field, v]) => !(field === 'scope' && Array.isArray(v) && v.length === 0));
  if (!narrows && r.problems.length + r.notes.length > named) r.matchesAll = true;
  return match;
}

/** A rule's resets: names of rules whose state it clears when it fires. An entry that isn't a name was dropped. */
function readResets(r: Reader, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    r.problems.push({
      text: `resets is ${shownValue(value)}, where a list of rule names is needed, such as ["other-rule"]`,
      read: 'so the rule resets no other',
    });
    return undefined;
  }
  // Unknown names are ignored at runtime, so reload races don't blow up.
  const names = value.filter((s): s is string => typeof s === 'string' && s.length > 0);
  const dropped = value.filter((s) => typeof s !== 'string' || s.length === 0);
  if (dropped.length > 0) {
    r.problems.push({
      text: `resets holds ${shownValues(dropped)}, where each entry is a rule's name`,
      read: names.length > 0 ? droppedEntries(dropped.length) : `${droppedEntries(dropped.length)}, and the rule resets no other`,
    });
  }
  return names.length > 0 ? names : undefined;
}

/**
 * A rule's passthrough. It's meaningful only on the counting behaviors, where
 * "matched but didn't fire" is a distinct outcome that can fall through. On
 * always, defer, skip or a debounce it would be a no-op at best and a
 * misleading promise at worst, so it's refused rather than ignored.
 */
function readPassthrough(
  r: Reader, value: unknown, behavior: GateBehavior | undefined, kind: BehaviorKind | undefined,
): boolean {
  if (value === undefined || value === false) return false;
  if (value !== true) {
    r.problems.push({ text: `passthrough is ${shownValue(value)}, where true or false is needed` });
    return false;
  }
  if (kind === undefined || kind === 'rate_limit' || kind === 'passive_sample') return true;
  r.problems.push({
    text: `passthrough is only valid with rate_limit or passive_sample behaviors — for "${behavior ? formatBehavior(behavior) : kind}" `
      + 'there is no non-firing match to fall through on',
  });
  return false;
}

/** What a load or a start does with a rule. */
type RuleOutcome = 'as-written' | 'read' | 'left-out';

/**
 * A rule with no problem is in force as written. One with a problem is read
 * past it, the way earlier releases read it, so it wakes the agent wherever
 * they did and holds back what they held back, a rule that skips or defers
 * included. It's left out only where they refused it.
 */
function ruleOutcome(reading: RuleReading): RuleOutcome {
  if (reading.problems.length === 0) return 'as-written';
  return reading.policy === undefined ? 'left-out' : 'read';
}

/** What a load or a start says of a rule: how it's read past its problems, or that it's left out, and its notes. */
function readingSentences(reading: RuleReading, outcome: RuleOutcome): string[] {
  const said: string[] = [];
  if (outcome === 'read') {
    // Read past a problem that can widen it, a rule that holds events back holds back what it now matches.
    const behavior = reading.policy?.behavior;
    const holds = (behavior === 'skip' || behavior === 'defer') && reading.problems.some((p) => !p.narrows)
      ? ` Read so, it ${behavior === 'skip' ? 'skips' : 'defers'} every event it now matches, as earlier releases did.`
      : '';
    said.push(`${reading.where}: ${reading.problems.map((p) => `${p.text}, ${p.read}`).join('; ')}.${holds}`);
  } else if (outcome === 'left-out') {
    said.push(`${reading.where} is left out: ${reading.problems.map((p) => p.text).join('; ')}.`);
  }
  return [...said, ...notesOf(reading)];
}

/** addPolicy's refusal of a rule with problems: every one of them, and its notes. */
function refusalOf(reading: RuleReading): string {
  return [`${reading.where} wasn't saved: ${reading.problems.map((p) => p.text).join('; ')}.`, ...notesOf(reading, true)].join(' ');
}

/** gate.json, or the host's starting rules, as the gate reads them. */
type ConfigReading =
  /** Not used: why, and what a change would edit, since one that parses is
   *  edited as written, whether it's used or not (rulesForChange); where it's
   *  the rules left out, each one's name, or undefined for one without. */
  | { refused: string; listed: Listed; silenced?: Array<string | undefined> }
  | {
    /** What's in force from it. */
    config: GateConfig;
    /** Each rule as given, as read, and what's done with it. */
    rules: Array<{ raw: unknown; reading: RuleReading; outcome: RuleOutcome }>;
    /** What the gate says of it, each a sentence: its own problems and notes, then each rule's. */
    sentences: string[];
    /** Its own fields as loaded, and its rule list, each rule as written, for
     *  a write to edit by name; or, for one with no rule list to edit (a list,
     *  or a "policies" that isn't one and holds something), what it is instead. */
    listed: Listed;
  };

/** A gate.json's own fields and its rule list, as written, or why it has none a write could edit. */
type Listed = { top: Record<string, unknown>; rules: unknown[] } | { noList: string };

/** A rule's name as written, when it has a usable one. */
function nameOf(rule: unknown): string | undefined {
  return isPlainObject(rule) && typeof rule.name === 'string' && rule.name ? rule.name : undefined;
}

/** What a load of gate.json says, from what its reading says of it: nothing, when that's nothing. */
function loadNote(sentences: readonly string[]): string | null {
  return sentences.length > 0 ? `gate.json loaded. ${sentences.join(' ')}` : null;
}

/** The names of the rules a gate.json holds as written: none, for one with no rule list. */
function heldNames(listed: Listed): Set<string> {
  return new Set('noList' in listed ? [] : listed.rules.map(nameOf).filter((name): name is string => name !== undefined));
}

/**
 * gate.json, or the host's starting rules, read (`file` names which in
 * messages). A file earlier releases loaded loads as they read it, with a
 * note naming what they didn't read: a list is read as no rules under the
 * default "always", and a slip of "policies", a name the gate doesn't read
 * (a list of rules parked under one included), a field of a rule at the
 * file's top and a "policies" that isn't a list each as nothing, so where
 * "policies" writes no rules the file has none, and its default decides every
 * event. A "policies" holding nothing, an empty list or one that isn't a
 * list, writes no rules, as one left out does. Earlier releases refused it
 * whole where it isn't an object, or its default isn't one of the three, and
 * it isn't used. Each rule is read on its own. Under a default that holds
 * events back, a rule left out that could wake the agent would hold back what
 * it was written to wake on, so the file isn't used, as earlier releases,
 * which refused such a rule and so the file, didn't use it. `start` is what a
 * later start ran over a gate.json with no rules of its own, for its note: the
 * host's starting rules beside one with no rule list, or, where gate.json
 * isn't used at that start, the clause saying why and what runs instead
 * (notUsedClause), which the sentence saying it has no rules carries.
 */
function readConfig(
  raw: unknown, file: 'gate.json' | 'the starting config', start?: 'beside' | { notUsed: string },
): ConfigReading {
  const File = file === 'gate.json' ? file : 'The starting config';
  if (Array.isArray(raw)) {
    return {
      config: { policies: [], default: 'always' },
      rules: [],
      sentences: [
        `${File} is a list, where an object is needed, such as {"policies": [{"name": "my-rule", "behavior": "always"}]}, `
        + (start === 'beside'
          ? 'so none of it is read, and the gate runs the host\'s starting rules beside it, under the default, "always".'
          : 'so none of it is read, and every event gets the default, "always".'),
      ],
      listed: { noList: `${File} is a list` },
    };
  }
  if (!isPlainObject(raw)) return { refused: `${file} must be a JSON object`, listed: { noList: `${File} is ${shownValue(raw)}` } };

  const sentences: string[] = [];
  // At a start that doesn't use it, what having no rules does is that.
  const notUsedWhy = typeof start === 'object' ? start.notUsed : undefined;
  const notUsed = notUsedWhy === undefined ? undefined : `it has no rules, so ${notUsedWhy}`;
  const obj = withoutEmpty(file, raw, sentences, { ...configLeftOut(raw.default), ...(notUsed ? { policies: notUsed } : {}) });
  // Here a name holding "default" or "policies" isn't a slip of it: at the
  // top, such a name can be a label of the file ("policiesUpdated").
  const names = fieldNames(obj, CONFIG_FIELDS, false);
  const { misplaced, rest } = placedElsewhere(names.unread, homesOf(file, CONFIG_FIELDS));
  noteUnread(file, rest, CONFIG_FIELDS, sentences);
  for (const m of misplaced) {
    sentences.push(
      `${file} has ${misplacedShown(m)}, which the gate doesn't read here, so ${m.keys.length === 1 ? 'it does' : 'they do'} nothing.`,
    );
  }
  // A "policies" holding nothing writes no rules, as one left out does.
  const noPolicies = obj.policies === undefined || holdsNothing(obj.policies);
  // What a change edits, used or not: its own fields and rule list as written
  // (a list left out, null or "", or one holding nothing, is an empty one),
  // beside whatever else it holds; or, where "policies" isn't a list and holds
  // something, what it is instead, since a list there would write over it.
  const listed: Listed = noPolicies || Array.isArray(obj.policies)
    ? { top: raw, rules: Array.isArray(obj.policies) ? obj.policies : [] }
    : { noList: `${File}'s "policies" is ${shownValue(obj.policies)}` };
  const given = obj.default;
  if (given !== undefined && given !== 'always' && given !== 'defer' && given !== 'skip') {
    return { refused: `${file} "default" must be "always", "defer", or "skip", got: ${shownValue(given)}`, listed };
  }
  const defaultBehavior = given ?? 'always';
  // Beside a start that runs the host's starting rules, since it has no list to add them to, they're what its default
  // meets; at one that doesn't use it, what runs in its place is.
  const noRules = start === 'beside'
    ? `it has no rules, so the gate runs the host's starting rules beside it, under its default, "${defaultBehavior}"`
    : notUsed ?? configLeftOut(defaultBehavior).policies;
  for (const slip of names.slips) {
    let read = SLIP_READ;
    // Where "policies" writes no rules, what a slip of it holds leaves the file with none.
    if (slip.meant.includes('policies') && noPolicies) read = `and ${noRules}`;
    else if (slip.meant.includes('default') && obj.default === undefined) read = 'so its default is "always"';
    sentences.push(`${File} has ${slipShown(slip)}, which the gate doesn't read, ${read}.`);
  }
  const policies: unknown[] = Array.isArray(obj.policies) ? obj.policies : [];
  if (!Array.isArray(obj.policies) && obj.policies !== undefined) {
    sentences.push(
      `${File}'s "policies" is ${shownValue(obj.policies)}, where a list of rules is needed, such as `
      + `[{"name": "my-rule", "behavior": "always"}], and ${noRules}.`,
    );
  }

  const rules = policies.map((rule, i) => {
    const reading = readRule(rule, `The ${ordinal(i + 1)} policy`, file);
    return { raw: rule, reading, outcome: ruleOutcome(reading) };
  });
  if (defaultBehavior !== 'always') {
    const silenced = rules.filter((rule) => rule.outcome === 'left-out' && !rule.reading.quiet);
    if (silenced.length > 0) {
      const one = silenced.length === 1;
      return {
        refused: [
          `${file} leaves out ${one ? 'a rule' : 'rules'} that could wake the agent, and under its default, "${defaultBehavior}", `
          + `what ${one ? 'it was' : 'they were'} written to wake it on would be held back.`,
          ...silenced.flatMap((rule) => readingSentences(rule.reading, rule.outcome)),
        ].join(' '),
        listed,
        silenced: silenced.map((rule) => nameOf(rule.raw)),
      };
    }
  }
  for (const rule of rules) sentences.push(...readingSentences(rule.reading, rule.outcome));
  // A list with no rules, or none the gate reads, where no sentence above said it has none.
  if (notUsed !== undefined && !sentences.some((said) => said.includes(notUsed))) {
    sentences.push(`${File} has no rules${rules.length > 0 ? ' but ones the gate leaves out' : ''}, so ${notUsedWhy}.`);
  }
  return {
    config: {
      policies: rules.filter((rule) => rule.outcome !== 'left-out').map((rule) => rule.reading.policy as GatePolicy),
      default: defaultBehavior,
    },
    rules,
    sentences,
    listed,
  };
}

/** One of the host's starting rules: as given, with its name when it has one, and as read. */
interface StartingRule { name: string | undefined; raw: unknown; policy: GatePolicy | undefined; quiet: boolean }

/** The host's starting rules (initialConfig), read as gate.json is, for the seed and the reconcile. */
interface StartingRules {
  /** Why none of them is used, when that's so. */
  refusedWhole?: string;
  /** What they put in force when gate.json can't be loaded: each rule not left out, as read. */
  config?: GateConfig;
  /** With `config`, the starting config as given, which a first start writes,
   *  since gate.json is read the same way. */
  given?: unknown;
  /** Each starting rule as given, with its name when it has one, for the reconcile to add by name, and as read:
   *  the rule, unless it's left out, and whether it wakes on none of what it matches (RuleReading.quiet). */
  rules: StartingRule[];
  /** What the gate says of them, each a sentence. */
  sentences: string[];
}

function readStartingRules(raw: unknown): StartingRules {
  const read = readConfig(raw, 'the starting config');
  if ('refused' in read) return { refusedWhole: read.refused, rules: [], sentences: [] };
  return {
    config: read.config,
    given: raw,
    rules: read.rules.map((rule) => ({ name: nameOf(rule.raw), raw: rule.raw, policy: rule.reading.policy, quiet: rule.reading.quiet })),
    sentences: read.sentences,
  };
}

/**
 * The recipe the gate last applied (lastRecipePath), as written, or null when
 * it has none on record. A record that exists and isn't one the gate wrote (it
 * can't be read, isn't JSON, holds no list of rules, is refused as the
 * starting rules are, or names a rule twice) gives null with the reason, which
 * quotes nothing from the file but a rule's name: a start then removes and
 * redefines nothing, as the first does, and says why.
 */
function readLastRecipe(path: string): { recipe: WrittenConfig | null; problem?: string } {
  if (!existsSync(path)) return { recipe: null };
  let raw: unknown;
  try {
    raw = parseGateJson(readFileSync(path, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { recipe: null, problem: code ? `reading it failed with ${code}` : "it isn't JSON" };
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.policies)) return { recipe: null, problem: 'it holds no list of policies' };
  if ('refused' in readConfig(raw, 'the starting config')) return { recipe: null, problem: "it isn't read as the starting rules are" };
  const twice = duplicateName(raw.policies);
  if (twice !== undefined) return { recipe: null, problem: `it names the rule "${twice}" twice` };
  return { recipe: { rules: raw.policies, default: raw.default } };
}

/**
 * A rule's meaning, for the start's merge: the rule as the gate reads it,
 * where it reads, and as written where it doesn't. So a rule `wake_add_rule`
 * wrote as read agrees with the same rule written more briefly.
 */
function ruleMeaning(rule: unknown): string {
  const reading = readRule(rule, 'A policy');
  return reading.policy ? `read ${canonical(reading.policy)}` : `written ${canonical(rule)}`;
}

/** What a start's write of the host's starting rules to gate.json did. */
type StartWrite =
  | { kind: 'none' }
  /** A first start's write of the starting rules threw: at its open, or partway. */
  | { kind: 'seed-failed'; error: string; atOpen: boolean }
  /**
   * A later start's write to gate.json threw, or couldn't be made; `config` is
   * what it was writing: the rules it read plus the ones it was adding
   * (`names`), with the merge's other changes (`changing`: the rules it was
   * removing, redefining or moving, and "default").
   */
  | {
    kind: 'reconcile-failed'; names: string[]; changing?: string[]; error: string; atOpen: boolean; config: GateConfig;
    /** The text it was writing, whose reading is `config`, and what a load of it says, when the write itself failed. */
    text?: string;
    note?: string | null;
    sentences?: readonly string[];
  }
  /** A later start over a gate.json with no rule list to add the ones it lacks to: `config` is gate.json's default with them, which the gate runs beside it, unsaved. */
  | { kind: 'reconcile-unsaved'; names: string[]; error: string; config: GateConfig }
  /** A later start over a gate.json with no rules of its own (no rule list, an empty one, or one holding only rules the
   *  gate leaves out) whose default, `default`, holds events back, where the host's starting rules can't all be put in
   *  force beside it or in it: some that could wake the agent are left out (`leftOut`, by name, and `nameless`, a count of
   *  those with no name) or kept out by gate.json's rules of their names, which the gate leaves out (`heldOut`); or
   *  they're refused whole under their own default. gate.json isn't used at that start, which runs as one without it
   *  does. */
  | {
    kind: 'start-without'; default: NonNullable<GateConfig['default']>;
    leftOut?: string[]; nameless?: number; heldOut?: string[];
  };

/**
 * What gate_status says about the start, which stays until the next one: the
 * host's starting rules that couldn't be used and what the start did instead,
 * how it read them past problems, and rules a reconcile couldn't add. Worded
 * about the start, so later writes and reloads
 * leave it true; configSource says what's in force now. `held` is the names
 * of the rules gate.json holds as written, when it loaded.
 */
function describeStart(starting: StartingRules, write: StartWrite, held: ReadonlySet<string> | null): string | null {
  const parts: string[] = [];
  if (starting.refusedWhole !== undefined) {
    // gate.json's rules: as loaded, or as read before a write of the start's
    // own left it unable to load; or none, where gate.json wasn't used either.
    const instead = write.kind === 'start-without'
      ? `gate.json, which has no rules the gate reads, wasn't used either: under its default, "${write.default}", it would hold back every `
        + 'event, so the gate started with no rules, as a start without gate.json does. Giving gate.json rules under '
        + '"policies", or fixing the starting rules, puts rules in force (a fix to the starting rules, at the next start).'
      : held !== null || write.kind === 'reconcile-failed'
        ? "The gate started with gate.json's rules."
        : 'The gate started with no rules, as on a host without starting rules.';
    parts.push(`At start, the host's starting rules weren't used: ${sentence(starting.refusedWhole)} ${instead}`);
  }
  if (starting.sentences.length > 0) parts.push(`In the host's starting rules, ${starting.sentences.join(' ')}`);
  // A reconcile whose write failed and left gate.json loading: the rules it
  // was adding didn't reach it, unless the write landed before failing.
  if (write.kind === 'reconcile-failed' && held) {
    if (!write.names.every((name) => held.has(name))) {
      parts.push(
        `At start, the host's starting rules ${quotedList(write.names)} couldn't be added to gate.json (${write.error}), `
        + "so they weren't put in force. "
        + (write.text !== undefined
          ? 'Whoever runs this host can fix what kept them from being written.'
          : 'A start adds them once what kept them out is fixed.'),
      );
    }
    // The merge's other changes: removals, redefinitions, moves and the default.
    if (write.changing?.length) {
      parts.push(
        `At start, the recipe's changes to gate.json (${quotedList(write.changing)}) `
        + (write.atOpen
          ? `weren't saved (${write.error}), so gate.json's rules are in force as they were. `
          : `may not all have been saved (${write.error}): the gate runs gate.json as the write left it. `)
        + (write.text !== undefined
          ? 'Whoever runs this host can fix what kept them from being written.'
          : 'A start applies them once what kept them out is fixed.'),
      );
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Why gate.json, which has no rules of its own, isn't used at a start that runs
 * as one without it (start-without), and what runs in its place: the clause
 * after "it has no rules, so" in its note.
 */
function notUsedClause(write: Extract<StartWrite, { kind: 'start-without' }>, starting: StartingRules): string {
  const back = 'Giving gate.json rules under "policies"';
  const out = outOfForce(write);
  if (out) {
    return `it isn't used at this start: under its default, "${write.default}", ${out.said}, so the gate runs the starting `
      + `rules under their own default, "${starting.config?.default ?? 'always'}", as a start without gate.json does. ${back}, or ${out.fix}, puts it in use`
      + (out.nextStart ? ' (a fix to the starting rules, at the next start)' : '');
  }
  return `under its default, "${write.default}", it would hold back every event: it isn't used at this start, and the gate runs `
    + `no rules, as a start without gate.json does, so every event gets the default, "always". ${back}, or fixing the starting rules, puts rules in force`
    + ' (a fix to the starting rules, at the next start)';
}

/**
 * The starting rules a start that doesn't use gate.json couldn't put in force
 * beside it or in it, which could wake the agent, and what would put them in
 * force: null where the starting rules were refused whole.
 */
function outOfForce(write: Extract<StartWrite, { kind: 'start-without' }>): { said: string; fix: string; nextStart: boolean } | null {
  const nameless = write.nameless ?? 0;
  const left = [...(write.leftOut ?? []).map((name) => `"${name}"`), ...(nameless === 0 ? [] : [nameless === 1 ? 'one with no name' : `${nameless} with no name`])];
  const held = write.heldOut ?? [];
  const said: string[] = [];
  const fix: string[] = [];
  if (left.length > 0) {
    said.push(`the host's starting rules would leave out ${joinedList(left)}, which could wake the agent`);
    fix.push(`fixing ${joinedList(left)} in the starting rules`);
  }
  if (held.length > 0) {
    said.push(`the host's ${quotedList(held)}, which could wake the agent, would be kept out by gate.json's `
      + `${held.length === 1 ? 'rule of that name' : 'rules of those names'}, which the gate leaves out`);
    fix.push(`fixing gate.json's ${quotedList(held)}`);
  }
  // While gate.json has no rules of its own, every one of them has to be put
  // in force for it to be used, so where both kinds keep it out, both fixes
  // are needed; giving gate.json rules of its own is the other way, which the
  // entry gives first.
  // The starting rules are read at a start, so a fix to them puts gate.json in
  // use from the next one.
  return said.length > 0
    ? { said: said.join(', and '), fix: fix.length > 1 ? `both ${fix.join(', and ')}` : fix[0]!, nextStart: left.length > 0 }
    : null;
}

/**
 * What gate_status says when the start left rules in force unsaved: a first
 * start's seed that failed, a reconcile whose write left gate.json unable to
 * load (`loaded` false), or, over a gate.json with no rule list (`loaded`
 * true), the starting rules it lacks, run beside it, or, over one with no rules
 * of its own, the starting rules run under their own default where gate.json
 * isn't used. It goes once gate.json is written, or a reload applies its text
 * or, but where the start ran rules beside or in place of such a gate.json,
 * finds it holding the text in force.
 */
function describeUnsaved(starting: StartingRules, write: StartWrite, loaded: boolean): string | null {
  if (write.kind === 'reconcile-unsaved') {
    if (!loaded) return null;
    return `At start, the host's starting rules ${quotedList(write.names)} couldn't be added to gate.json (${write.error}). `
      + `The gate runs them under gate.json's default, "${write.config.default ?? 'always'}", as if gate.json held them, but `
      + "they aren't saved in it: once gate.json changes and loads, what it holds is in force instead. Once gate.json has a "
      + 'list of rules under "policies", a start adds them to it, as to any gate.json with a list.';
  }
  if (write.kind === 'start-without') {
    // Starting rules refused whole put none in force, and describeStart says so.
    const out = outOfForce(write);
    if (!out) return null;
    return `At start, gate.json, which has no rules the gate reads, wasn't used: under its default, "${write.default}", ${out.said}. The gate `
      + `runs the starting rules under their own default, "${starting.config?.default ?? 'always'}", as a start without gate.json `
      + 'does, but they aren\'t saved in it: once gate.json changes and loads, what it holds is in force instead. Giving '
      + `gate.json rules under "policies", or ${out.fix}, puts it in use`
      + `${out.nextStart ? ' (a fix to the starting rules, at the next start)' : ''}.`;
  }
  if (loaded) return null;
  if (write.kind === 'seed-failed') {
    return write.atOpen
      ? `At start, gate.json couldn't be created (${write.error}), so the host's starting rules are in force but aren't saved in it. `
        + 'Whoever runs this host can fix what keeps it from being written.'
      : `At start, writing the host's starting rules to gate.json failed partway (${write.error}), so gate.json may be left `
        + "part-written. The starting rules are in force but aren't saved in it, and a restart before gate.json is fixed starts "
        + 'from them too. Whoever runs this host can fix what kept it from being written, and gate.json.';
  }
  if (write.kind === 'reconcile-failed') {
    // A write of the recipe's merge that did more than add rules, or one that only added them.
    const merging = (write.changing?.length ?? 0) > 0;
    const changes = quotedList([...write.names, ...(write.changing ?? [])]);
    const what = merging
      ? write.atOpen
        ? `the recipe's changes to gate.json (${changes}) couldn't be written (${write.error}), and gate.json couldn't be loaded after that`
        : `writing the recipe's changes to gate.json (${changes}) failed partway (${write.error}), so gate.json may be left part-written`
      : write.atOpen
        ? `the host's starting rules ${quotedList(write.names)} couldn't be added to gate.json (${write.error}), and gate.json `
          + "couldn't be loaded after that"
        : `adding the host's starting rules ${quotedList(write.names)} to gate.json failed partway (${write.error}), so gate.json `
          + 'may be left part-written';
    // What those rules hold that the gate reads past or leaves out, since
    // gate.json's own entry is now its load error.
    const read = write.sentences?.length ? `, read as a load reads them: ${write.sentences.join(' ')}` : '.';
    const runs = merging ? 'the rules that write held' : "the rules it read from gate.json and the ones it was adding";
    return `At start, ${what}. The gate runs ${runs}, which aren't saved${read} `
      + `A restart before gate.json is fixed starts from ${starting.config ? "the host's starting rules" : 'no rules'}. `
      + 'Whoever runs this host can fix what kept it from being written, and gate.json.';
  }
  return null;
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

/** The text of a thrown value, for a log line. It never throws itself, whatever was thrown. */
function errorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'a value that could not be printed';
  }
}

/**
 * Run a caller's callback once the change it's told of is made and traced. A
 * throw from it is logged, not thrown, so the call answers as the change it
 * made: told the change had failed, an agent could make it a second time.
 */
function afterChange(name: string, callback: () => void): void {
  try {
    callback();
  } catch (err) {
    console.error(`[gate] ${name} threw once the change was made, and the change stands: ${errorText(err)}`);
  }
}

/** The privileged-users file's error when some entries of its list aren't user ids. */
function skippedPrivilegedIds(skipped: unknown[], loaded: number): string {
  const one = skipped.length === 1;
  const shown = skipped.slice(0, 5).map((x) => {
    if (typeof x === 'number' && Number.isInteger(x)) {
      return `${x} (a number this large can't be read exactly: write the id as a string, in quotes)`;
    }
    const json = JSON.stringify(x) ?? String(x);
    return json.length > 40 ? `${safeSlice(json, 0, 39)}…` : json;
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
  /** The text of gate.json whose rules are in force, from a load or a write
   *  (or the start's reconcile, whose write failed); or, while what's in force
   *  is what a start ran beside gate.json or in its place (configSource not
   *  "file"), gate.json's text as that start found it.
   *  A reload parses the file again only when its text differs; a file that
   *  holds it again after failing to load (a chmod that makes it readable,
   *  an edit undone) needs nothing applied, only its error cleared. */
  private configText: string | undefined;
  /** The notes on fields the text in force has that the gate doesn't read, if any. */
  private configNote: string | null = null;
  private lastReloadCheck: number = 0;
  private configSource: 'file' | 'initial' | 'default' = 'default';
  private lastReloadTimestamp: number | null = null;
  /** The current problem with each file the gate reads, one each, replaced
   *  whenever that file is read again (gate_status `errors`). */
  private configError: string | null = null;
  /** Whether gate.json's error is one that keeps what it holds out of force
   *  (configUnreadable), so gate_status says what's in force instead. */
  private configUnused = false;
  private privilegedError: string | null = null;
  /** What the start did with the host's starting rules that it couldn't use
   *  or add (describeStart), kept apart from gate.json's own error, until the
   *  next start. */
  private startNotice: string | null = null;
  /** The rules in force that the start couldn't save (describeUnsaved),
   *  until gate.json is written or a reload applies its text. */
  private startUnsaved: string | null = null;
  /** What the start's merge of the recipe couldn't do (seedOrReconcile), said with startNotice until the next start. */
  private startMergeNote: string | null = null;
  /** Whether the start's unsaved rules (startUnsaved) are a merge's that did more than add rules. */
  private startUnsavedMerged = false;

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
  // From dispose() to the next resumeSleep(): no sleep or self-wake timer is
  // armed, though a turn a failed stop() left running can still ask for one.
  private disposed = false;

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
    /** Out-param: where the message landed, for the wake that goes with it. */
    placement?: WritePlacement,
  ) => unknown;
  private requestInferenceFn: (agentName: string, reason: string, source: string, provenance?: WakeProvenance, after?: WritePlacement) => void;
  private getAgentNamesFn: () => string[];
  private resolveRouteChannelFn: (info: GateEventInfo) => string | undefined;
  private channelShownFn?: (channel: { serverId: string; channelId: string }) => string;
  private isNewestEntryFn?: (entry: GateEntryRef) => boolean;
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
      placement?: WritePlacement,
    ) => unknown;
    /** `after`: the placement of the message the wake is for, when it has
     *  one, so the host can drop the wake once a request that carried the
     *  message is answered. */
    requestInference: (agentName: string, reason: string, source: string, provenance?: WakeProvenance, after?: WritePlacement) => void;
    getAgentNames: () => string[];
    /** Optional clock — defaults to Date.now. Tests inject for deterministic time. */
    now?: () => number;
    /** Per-event timeout (ms) for the optional gate.js script. Default 50. */
    scriptTimeoutMs?: number;
    /** Map an event to the registered channel it arrived on (the host knows
     *  how push-event origins compose into channel ids). The gate routes a
     *  batched wake by it, tests a policy's `match.channel` against it when
     *  the event's own id misses, and keys `keyBy: "channelId"` counts on it.
     *  A resolver that throws counts as returning nothing. Default: a
     *  channel-incoming event's own channel id; nothing for push events, so
     *  a push then matches and counts by its own id alone. */
    resolveRouteChannel?: (info: GateEventInfo) => string | undefined;
    /** How the agent is shown a channel, its server's and its id (the
     *  framework's ChannelRegistry.nameShown): a batched wake's summary names
     *  each channel so, since two servers' channels can share an id. Default:
     *  the id. */
    channelShown?: (channel: { serverId: string; channelId: string }) => string;
    /** Whether an MCPL event's own context entry is still the newest entry in
     *  the window a batched wake's line would be written to, with nothing
     *  waiting to be written there. A batched wake for that one message
     *  doesn't write its line when it fires: it hands the line to the wake
     *  (WakeProvenance.line), for a fresh start of the wake's turn to decide
     *  (WakeLine). Absent: every batched wake writes its line, as before. */
    isNewestEntry?: (entry: GateEntryRef) => boolean;
  }) {
    this.configPath = opts.configPath;
    this.privilegedUsersPath = opts.privilegedUsersPath;
    this.emitTrace = opts.emitTrace;
    this.addMessageFn = opts.addMessage;
    this.requestInferenceFn = opts.requestInference;
    this.getAgentNamesFn = opts.getAgentNames;
    this.resolveRouteChannelFn = opts.resolveRouteChannel ?? defaultRouteChannel;
    this.channelShownFn = opts.channelShown;
    this.isNewestEntryFn = opts.isNewestEntry;
    this.now = opts.now ?? (() => Date.now());
    this.loadPrivileged();

    // Seed or reconcile the on-disk config from the host's starting rules
    // (`initialConfig`), which are read as gate.json is, rule by rule: a rule
    // with a problem is read past it, or left out (readConfig).
    //
    // First start: write `initialConfig` as given, since gate.json is read the
    // same way, and record it as the recipe last applied, beside gate.json.
    // Later starts: merge the recipe into gate.json against that record,
    // three ways and as written (seedOrReconcile), so a rule the recipe
    // dropped, renamed, moved or redefined follows it, while a rule edited at
    // run time or by `workspace--edit _config/gate.json`, and one no recipe
    // declared, stays. `default` follows the same rule: an unedited one takes
    // the recipe's.
    const initial = opts.initialConfig;
    const starting = initial !== undefined ? readStartingRules(initial) : undefined;
    const write: StartWrite = starting ? this.seedOrReconcile(starting) : { kind: 'none' };

    // Load config: gate.json; without it, the starting rules as read, unless
    // none of them is used; and otherwise no rules, as a host without any has. When a
    // reconcile's own write left gate.json unable to load, the gate runs what
    // that write held, the rules it read as the recipe's merge changed them,
    // since a failed write of ours shouldn't take rules out of force. Over a gate.json
    // with no rule list to add them to, it runs gate.json's default with the
    // starting rules it lacks, as earlier releases did once they had written
    // them over it, where seedOrReconcile gives them (reconcile-unsaved). Where
    // gate.json has no rules of its own and they can't run beside it or be
    // added to it (start-without), earlier releases couldn't load what they
    // wrote and ran the starting rules from memory, so gate.json isn't used,
    // and the start runs as one without it does.
    const read = this.readConfigFile();
    if (read.state === 'loaded') {
      // Beside a gate.json with no rule list, the host's starting rules it
      // lacks, and its note says they run beside it, or, in place of one with
      // no rules of its own, those a start without it runs, and its note says
      // why.
      const beside = write.kind === 'reconcile-unsaved';
      const without = write.kind === 'start-without' ? write : null;
      this.config = beside ? write.config : without ? (starting?.config ?? { ...DEFAULT_CONFIG }) : read.config;
      this.configText = read.text;
      const start = beside ? 'beside' : without && starting ? { notUsed: notUsedClause(without, starting) } : undefined;
      const asStarted = start ? readConfig(parseGateJson(read.text), 'gate.json', start) : null;
      this.configNote = asStarted && 'sentences' in asStarted ? loadNote(asStarted.sentences) : read.note;
      this.configError = this.configNote;
      this.configSource = beside || starting?.config && without ? 'initial' : without ? 'default' : 'file';
      if (this.configNote) console.error(`[gate] ${this.configNote}`);
    } else if (write.kind === 'reconcile-failed') {
      this.config = write.config;
      // A change over the part-written gate.json is refused; once gate.json is
      // gone, this text is what a change edits, so every rule it holds keeps its name.
      this.configText = write.text;
      this.configNote = write.note ?? null;
      this.configSource = 'file';
    } else {
      this.config = starting?.config ?? { ...DEFAULT_CONFIG };
      this.configSource = starting?.config ? 'initial' : 'default';
    }
    // What the start did is kept apart from gate.json's load error, so the
    // load above can't clear it when it succeeds.
    if (starting) {
      const described = describeStart(starting, write, read.state === 'loaded' ? heldNames(read.listed) : null);
      this.startNotice = [described, this.startMergeNote].filter((part): part is string => part !== null).join(' ') || null;
      this.startUnsaved = describeUnsaved(starting, write, read.state === 'loaded');
      this.startUnsavedMerged = write.kind === 'reconcile-failed' && (write.changing?.length ?? 0) > 0;
    }
    for (const said of [this.startNotice, this.startUnsaved]) {
      if (said) console.error(`[gate] ${said}`);
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

  /**
   * Write the starting rules to gate.json, as given, when it's absent, and
   * record them as the recipe last applied (lastRecipePath); or, when it
   * loads, merge them into its own rule list against that record, three ways
   * and as written (reconcileWithRecipe), and record them. A rule as the last
   * recipe left it follows the new one, a rule edited since keeps its edit, a
   * rule no recipe declared stays, and `default` follows the same rule. A
   * rule gate.json holds holds its name, whether the gate reads it or leaves
   * it out. gate.json is written before the record, so a stop between the two
   * leaves a state the next start reads rightly: the other order would make
   * the old recipe's rules read as edits. Nothing is recorded where gate.json
   * isn't written as the merge asks, or a name is given twice. Where
   * gate.json has no rules of its own and, under its default, one of them that
   * could wake the agent can't be put in force (left out, with no name, or kept
   * out by a rule of gate.json's of its name that the gate leaves out), or
   * they're refused whole and that default holds events back, gate.json isn't
   * used at this start, which runs as one without it does. Otherwise, where
   * gate.json has no rule list to add them to, it writes nothing, and the gate
   * runs beside it those of them it reads. Says what it did when that wasn't
   * simply done or not needed.
   */
  private seedOrReconcile(starting: StartingRules): StartWrite {
    const read = this.readConfigFile();
    if (read.state === 'absent') {
      if (!starting.config) return { kind: 'none' };
      try {
        mkdirSync(dirname(this.configPath), { recursive: true });
        writeFileSync(this.configPath, JSON.stringify(starting.given, null, 2) + '\n');
      } catch (err) {
        return { kind: 'seed-failed', error: errorText(err), atOpen: beforeWriting(err) };
      }
      const twice = duplicateName(starting.rules.map((rule) => rule.raw));
      if (twice !== undefined) {
        this.startMergeNote = `At start, the recipe names the rule "${twice}" twice, so it wasn't recorded as the recipe last `
          + 'applied: a later start merges the recipe by name, and applies one that names each rule once.';
      } else {
        this.recordRecipe(lastRecipePath(this.configPath), starting.given);
      }
      return { kind: 'none' };
    }
    if (read.state !== 'loaded') return { kind: 'none' };
    const held = heldNames(read.listed);
    const fileDefault = read.config.default ?? 'always';
    // No rule list, an empty one, or one holding only rules the gate leaves out.
    const noRules = read.config.policies.length === 0;
    // Starting rules refused whole put none beside or in a gate.json with no
    // rules of its own, which holds events back. Earlier releases wrote them
    // over it or into it, couldn't load what they wrote, and ran them from
    // memory, so gate.json isn't used at this start either.
    if (noRules && starting.refusedWhole !== undefined && fileDefault !== 'always') {
      return { kind: 'start-without', default: fileDefault };
    }
    // Nor can a start put in force, beside or in a gate.json with no rules of
    // its own, a starting rule a load leaves out, one with no name, which it
    // can't add by name, or one whose name gate.json holds in a rule the gate
    // leaves out, which keeps the host's rule of that name out. Where, under
    // gate.json's default, one of them could wake the agent, earlier releases
    // ran the starting rules from memory: they couldn't load what they wrote
    // over gate.json or into it, or, refusing its rule, didn't load it at all.
    // So gate.json isn't used at this start, which runs as one without it does.
    if (noRules && fileDefault !== 'always') {
      const out = starting.rules.filter((rule) => !rule.quiet && (rule.policy === undefined || (rule.name !== undefined && held.has(rule.name))));
      if (out.length > 0) {
        const named = out.flatMap((rule) => (rule.name === undefined ? [] : [rule.name]));
        return {
          kind: 'start-without',
          default: fileDefault,
          leftOut: named.filter((name) => !held.has(name)),
          nameless: out.length - named.length,
          heldOut: named.filter((name) => held.has(name)),
        };
      }
    }
    if ('noList' in read.listed) {
      const missing = starting.rules.filter((rule): rule is StartingRule & { name: string } => rule.name !== undefined && !held.has(rule.name));
      if (missing.length === 0) return { kind: 'none' };
      const names = missing.map((rule) => rule.name);
      // Adding them would write over what gate.json holds. Earlier releases
      // wrote them over it and ran them under its default, so the gate runs
      // them so, unsaved, beside it.
      const error = `${read.listed.noList}, so there's no list of rules to add them to without writing over what it holds`;
      // The ones it runs: a starting rule left out is named as the starting rules are read.
      const running = missing.flatMap((rule) => (rule.policy === undefined ? [] : [rule.policy]));
      if (running.length === 0) return { kind: 'reconcile-failed', names, atOpen: true, config: read.config, error };
      return { kind: 'reconcile-unsaved', names: running.map((policy) => policy.name), error, config: { policies: running, default: fileDefault } };
    }
    // Starting rules refused whole have nothing to merge or record.
    if (starting.refusedWhole !== undefined) return { kind: 'none' };
    // The merge, as written: gate.json's rule list and default against the
    // recipe's, three ways, with the recipe last applied.
    const recordPath = lastRecipePath(this.configPath);
    const last = readLastRecipe(recordPath);
    const given = isPlainObject(starting.given) ? starting.given : {};
    let merged: ReturnType<typeof reconcileWithRecipe>;
    let appended = false;
    try {
      merged = reconcileWithRecipe(
        { rules: read.listed.rules, default: read.listed.top.default },
        { rules: starting.rules.map((rule) => rule.raw), default: given.default },
        last.recipe,
        ruleMeaning,
      );
    } catch (err) {
      // A name given twice: a merge by name can't say which rule was meant.
      // So the start adds the rules gate.json lacks, after its own, as
      // earlier releases did, and removes, redefines and records nothing.
      const missing = starting.rules.filter((rule): rule is StartingRule & { name: string } => rule.name !== undefined && !held.has(rule.name));
      appended = true;
      this.startMergeNote = `At start, ${errorText(err)}, and the merge with the recipe needs one rule per name, so it didn't run: `
        + (missing.length > 0
          ? `the start only adds the rules gate.json lacks (${quotedList(missing.map((rule) => rule.name))}), after its own, and `
            + 'removes, redefines and records nothing.'
          : 'gate.json is as it was, and nothing was recorded.');
      merged = {
        rules: [...read.listed.rules, ...missing.map((rule) => rule.raw)],
        default: read.listed.top.default,
        defaultChanged: false,
        changes: { ...noChanges(), added: missing.map((rule) => rule.name) },
      };
    }
    const { changes } = merged;
    if (last.problem !== undefined) changes.recordUnreadable = last.problem;
    const top = { ...read.listed.top };
    if (merged.defaultChanged) {
      if (merged.default === undefined) delete top.default;
      else top.default = merged.default;
    }
    const reconciled = { ...top, policies: merged.rules };
    const names = [...changes.added, ...changes.restored];
    const changing = [...changes.removed, ...changes.updated, ...changes.moved, ...(changes.defaultChange ? ['default'] : [])];
    if (canonical(reconciled) !== canonical({ ...read.listed.top, policies: read.listed.rules })) {
      // What the write holds, as a load reads it, for a write that fails partway.
      const holds = readConfig(reconciled, 'gate.json');
      if ('refused' in holds) {
        // A write of ours doesn't take gate.json's own rules out of force:
        // nothing is written or recorded, so it loads as it did. (With no
        // rules of its own, gate.json isn't used at this start, above.)
        const error = 'with them, gate.json would leave out a rule that could wake the agent, and under its default, '
          + `"${read.config.default ?? 'always'}", it wouldn't be used`;
        return { kind: 'reconcile-failed', names, changing, atOpen: true, config: read.config, error };
      }
      const text = JSON.stringify(reconciled, null, 2) + '\n';
      try {
        writeFileSync(this.configPath, text);
      } catch (err) {
        return {
          kind: 'reconcile-failed',
          names,
          changing,
          error: errorText(err),
          atOpen: beforeWriting(err),
          config: holds.config,
          text,
          note: loadNote(holds.sentences),
          sentences: holds.sentences,
        };
      }
    }
    // Said before the record is written, so a failed record write still
    // leaves what the start did to gate.json named. A start that only added
    // rules, since the merge couldn't run, is said in startNotice instead.
    const line = appended ? null : reconcileLine(changes);
    if (line) console.error(line);
    if (line || names.length > 0) {
      this.emitTrace({
        type: 'gate:config-reconciled',
        configPath: this.configPath,
        ...changes,
        // Every name the start added to gate.json, as an append's trace gave.
        addedPolicies: names,
        timestamp: Date.now(),
      });
    }
    if (!appended && (!last.recipe || canonical({ rules: last.recipe.rules, default: last.recipe.default }) !== canonical({ rules: starting.rules.map((rule) => rule.raw), default: given.default }))) {
      this.recordRecipe(recordPath, starting.given);
    }
    return { kind: 'none' };
  }

  /**
   * Record the starting config, as given, as the recipe last applied, after
   * gate.json holds what the start merged. A write that fails is said with the
   * start: the next start merges against the record as the write left it.
   */
  private recordRecipe(recordPath: string, given: unknown): void {
    try {
      writeFileSync(recordPath, JSON.stringify(given, null, 2) + '\n');
    } catch (err) {
      this.startMergeNote = `At start, recording the recipe in ${basename(recordPath)} failed (${errorText(err)}), `
        + 'so the next start merges against the record as this write left it.';
    }
  }

  /**
   * gate.json as it is on disk: absent; loaded; refused, when it's JSON that
   * readConfig doesn't use; or unreadable, when it can't be read or isn't
   * JSON (`notJson`, where it could be read). A loaded file comes with its note,
   * which names what it holds that does nothing or is read past a problem, and
   * a loaded or refused one with its own fields and rule list as written, for a
   * write to edit (Listed).
   * Reading applies nothing: whoever applies a loaded config records its text
   * as `configText`. With `unlessUnchanged`, a file whose text is
   * `configText` comes back `unchanged`, unparsed, since the rules in force
   * came from it, or are what a start ran beside it or in its place.
   */
  private readConfigFile(opts?: { unlessUnchanged?: boolean }):
    | { state: 'absent' }
    | { state: 'unchanged' }
    | { state: 'loaded'; config: GateConfig; text: string; note: string | null; listed: Listed }
    | { state: 'refused'; error: string; listed: Listed; silenced?: Array<string | undefined> }
    | { state: 'unreadable'; error: string; notJson?: true } {
    let raw: string;
    try {
      raw = readFileSync(this.configPath, 'utf-8');
    } catch (err) {
      if (!isMissing(err)) return this.configUnreadable(err);
      // No file is no problem with it: the rules in force stay.
      this.configError = null;
      this.configUnused = false;
      return { state: 'absent' };
    }
    // A file holding the text in force has that text's notes as its error,
    // whatever a failed read or a look at other text since left there: beside
    // the host's starting rules, they say those run beside it.
    const inForce = raw === this.configText;
    if (opts?.unlessUnchanged && inForce) {
      this.configError = this.configNote;
      this.configUnused = false;
      return { state: 'unchanged' };
    }
    let parsed: unknown;
    try {
      parsed = parseGateJson(raw);
    } catch (err) {
      return { ...this.configUnreadable(err), notJson: true };
    }
    const read = readConfig(parsed, 'gate.json');
    // JSON the gate doesn't use is still the operator's file, edited as written.
    if ('refused' in read) {
      return { ...this.configUnreadable(new Error(read.refused)), state: 'refused', listed: read.listed, silenced: read.silenced };
    }
    // A field the gate doesn't read does nothing, and a rule is read past a
    // problem or left out, so the file loads, and each is named.
    const note = loadNote(read.sentences);
    this.configError = inForce ? this.configNote : note;
    this.configUnused = false;
    return { state: 'loaded', config: read.config, text: raw, note, listed: read.listed };
  }

  /**
   * gate.json's current error, replacing the last one, and traced and logged
   * when it's new, so an edit that doesn't load is in the log once.
   */
  private configUnreadable(err: unknown): { state: 'unreadable'; error: string } {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== this.configError) {
      console.error(`[gate] ${this.configPath} couldn't be used (${msg}), so what it holds isn't in force`);
      this.emitTrace({
        type: 'gate:config-error',
        error: msg,
        configPath: this.configPath,
        timestamp: Date.now(),
      });
    }
    this.configError = msg;
    this.configUnused = true;
    return { state: 'unreadable', error: msg };
  }

  /**
   * gate.json's error as gate_status shows it: one that keeps what the file
   * holds out of force says what's in force instead, so it reads on its own.
   */
  private configErrorShown(): string | null {
    if (this.configError === null || !this.configUnused) return this.configError;
    return `${sentence(this.configError)} So what gate.json holds isn't in force, and the gate runs ${this.rulesRun()}.`;
  }

  /** What the gate runs, by where its rules came from, for a text that says so: "the host's starting rules". */
  private rulesRun(): string {
    if (this.config.policies.length === 0) return `no rules: every event gets the default, "${this.config.default ?? 'always'}"`;
    // Rules from a gate.json text, with the start's unsaved: only a start
    // whose reconcile write left gate.json unable to load runs those, since a
    // write of gate.json that lands, a reload that finds it holding a text
    // that loads, or, while gate.json's rules are in force, one that finds it
    // holding the text in force, clears startUnsaved.
    return this.configSource === 'file'
      ? this.startUnsaved !== null
        ? this.startUnsavedMerged
          ? 'the rules its start was writing to gate.json'
          : 'the rules it read from gate.json at start and the ones it was adding'
        : 'the rules of the last gate.json it used'
      : "the host's starting rules";
  }

  /**
   * What a policy change edits: gate.json's own fields and rule list as
   * written, each rule as written, so a write keeps every rule it doesn't
   * change, problems and unknown fields included, whether gate.json loads or
   * is JSON the gate doesn't use. Over one it doesn't use, writeConfig writes
   * only what loads, so a change is refused, naming what keeps the file out
   * and what would bring it into force (`remedy`), unless it mends that, and
   * the file stays as its operator wrote it. When
   * gate.json is absent, the same of the text whose rules are in force, so a
   * rule it leaves out keeps its name; or the rules in force, where no text
   * is, it has no rule list, or what's in force is what a start ran beside or
   * in place of it. A change is refused (`refused`) for a gate.json that can't
   * be read or isn't JSON (unusableRefusal), whose rules can't be edited
   * without writing over what it holds, and for one with no rule list a write
   * could edit without that (a list, a "policies" that isn't one and holds
   * something, or JSON that isn't an object): so a removal or an anchor is
   * refused too, rather than looked for in rules that may not be what the
   * file holds. It's refused as well for a gate.json that holds the text a
   * start didn't use (start-without), since what the change wrote would put
   * its rules in force in place of what the start runs.
   */
  private rulesForChange():
    | { top: Record<string, unknown>; rules: unknown[]; remedy?: string }
    | { refused: string } {
    const read = this.readConfigFile();
    if (read.state === 'unreadable') return { refused: unusableRefusal(read, this.rulesRun()) };
    if (read.state === 'loaded' || read.state === 'refused') {
      if ('noList' in read.listed) return { refused: noListRefusal(read.listed.noList, this.rulesRun()) };
      // Rules not gate.json's in force while it holds the text in force: what a
      // start ran in place of one with no rules of its own, until it changes.
      if (read.state === 'loaded' && read.text === this.configText && this.configSource !== 'file') {
        return { refused: notUsedRefusal(this.rulesRun()) };
      }
      const edit = { top: read.listed.top, rules: [...read.listed.rules] };
      if (read.state === 'loaded') return edit;
      // What would bring it into force, for a change that doesn't. A change
      // finds its rule by name: a replacement takes the first rule with it,
      // and a removal every one.
      const names = [...new Set(read.silenced ?? [])];
      const only = names.length === 1 ? names[0] : undefined;
      const sharing = only === undefined ? 0 : edit.rules.filter((rule) => nameOf(rule) === only).length;
      // A removal that would leave no rules in force is refused (writeConfig),
      // so it isn't offered.
      const rest = readConfig({ ...edit.top, policies: edit.rules.filter((rule) => nameOf(rule) !== only) }, 'gate.json');
      const removes = !('refused' in rest) && rest.config.policies.length > 0;
      return {
        ...edit,
        remedy: sharing === 1
          ? `${removes ? 'Replacing or removing' : 'Replacing'} "${only}" by name would bring gate.json into force.`
          : sharing > 1
            ? `gate.json has ${sharing} rules named "${only}", and a change by that name replaces the first of them`
              + `${removes ? ' or removes them all' : ''}.`
            : 'No change through the gate can bring it into force, so gate.json has to be fixed by an edit of its own; '
              + 'until then, a change is refused the same way.',
      };
    }
    // While the rules in force aren't gate.json's, configText is the text a
    // start ran them beside or in place of, so its rules aren't the ones in force.
    const text = this.configText !== undefined && this.configSource === 'file'
      ? readConfig(parseGateJson(this.configText), 'gate.json')
      : undefined;
    return text && !('refused' in text) && !('noList' in text.listed)
      ? { top: text.listed.top, rules: [...text.listed.rules] }
      : { top: { policies: [], default: this.config.default ?? 'always' }, rules: [...this.config.policies] as unknown[] };
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

  /**
   * Clear the state of each rule `was` held in force that `next` leaves out or
   * gives another behavior: a reload calls it before it puts `next` in force,
   * a write after. Without this, a rule that came back, or whose tokens 100
   * became 5 (or keyBy switched, or every 10 became 3), would run on the
   * buckets and counters of the rule it was. A rule left out loses its stats
   * (matchCount, lastMatchTimestamp) too; a rule kept keeps them, which are
   * history, not live state, and one kept with the same behavior keeps all its
   * state, its denial and fire counts included. Rules that share a name share
   * its state, so a name keeps it only where its rules, in order, keep their
   * behaviors. Each pending debounce batch is sent last, as its timer would
   * have sent it, once every rule's state is cleared; one whose delivery throws
   * is named in the log and dropped (fireDebounce), and the rest are still
   * sent, so the write or reload that cleared it has done what it was for, its
   * caller hears that it did, and no state is left behind.
   */
  private clearStateFor(was: GateConfig, next: GateConfig): { removed: string[]; cleared: string[] } {
    const behaviorsByName = (config: GateConfig): Map<string, string> => {
      const byName = new Map<string, string[]>();
      for (const p of config.policies) byName.set(p.name, [...(byName.get(p.name) ?? []), behaviorFingerprint(p.behavior)]);
      return new Map([...byName].map(([name, behaviors]) => [name, JSON.stringify(behaviors)]));
    };
    const before = behaviorsByName(was);
    const after = behaviorsByName(next);
    const removed = [...before.keys()].filter((name) => !after.has(name));
    for (const name of removed) {
      this.clearPolicyState(name);
      this.stats.delete(name);
    }
    const cleared = [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name));
    for (const name of cleared) this.clearPolicyState(name);
    for (const name of [...removed, ...cleared]) this.fireDebounce(name);
    return { removed, cleared };
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (checkedRecently(now, this.lastReloadCheck)) return;
    this.lastReloadCheck = now;

    try {
      // Missing, unchanged or unreadable: the rules in force stay.
      const read = this.readConfigFile({ unlessUnchanged: true });
      // gate.json holds the text in force, so none the start ran is unsaved,
      // unless what's in force is what the start ran beside it or in its place.
      if (read.state === 'unchanged' && this.configSource === 'file') this.startUnsaved = null;
      if (read.state !== 'loaded') return;
      const newConfig = read.config;

      const { removed: removedPolicies, cleared: stateClearedPolicies } = this.clearStateFor(this.config, newConfig);

      this.config = newConfig;
      this.compiledPolicies = this.compilePolicies(newConfig);
      // Recorded only now that its rules are in force, so a reload that
      // throws before here is tried again at the next check.
      this.configText = read.text;
      this.configNote = read.note;
      this.configSource = 'file';
      if (read.note) console.error(`[gate] ${read.note}`);
      // The rules in force are now gate.json's, so none the start ran is unsaved.
      this.startUnsaved = null;
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
   * The raw policy is read with the SAME `readRule` used when loading gate.json,
   * and since its caller is there to fix it, any problem it has throws, naming
   * every one (nothing is written), and the caller surfaces it as a tool error,
   * where a load reads past it (readConfig). On success the policy is persisted
   * to gate.json (so it survives restart and is visible to `workspace--edit _config/gate.json`)
   * and the in-memory config is swapped in immediately, so the rule takes effect
   * without waiting for the throttled reload.
   *
   * The freshest on-disk config is re-read first, so a concurrent operator edit
   * isn't clobbered, and the change edits gate.json's own rule list by name:
   * every rule it doesn't change is written back as it was written, problems and
   * fields the gate doesn't read included, and so is everything else gate.json
   * holds, such as a list of rules parked under another name, beside which a
   * change adds a "policies" list where there's none (rulesForChange). Over a
   * gate.json the gate doesn't use, only a change after which it loads is
   * written, such as one replacing or removing the rule that keeps it out, and
   * that leaves it rules in force, since it holds events back by default; any
   * other is refused, naming what does, and the file stays as written. When
   * gate.json is absent, the change edits the text whose rules are in force the
   * same way, or the rules in force where there's none. A gate.json that can't
   * be read or isn't JSON is refused (unusableRefusal), and stays as it is. A policy with the
   * same `name` is replaced IN PLACE when no `position` is given (order
   * preserved); WITH a `position` it is moved there — so re-issuing a rule is
   * also how you reposition it. New policies append by default; `'prepend'` puts
   * one at the very front (ahead of EVERYTHING, including addressed-message wake
   * rules — see the shadow lint), and the anchored forms `{before: name}` /
   * `{after: name}` insert relative to an existing rule, which is almost always
   * the safer way to order a sampler or debounce against a specific catch-all.
   * Fields of the policy the gate reads nowhere, and that aren't a slip of one
   * it does, are left out of what's written, and named to `onIgnoredFields` once
   * the change is written and traced. A throw from the callback is logged,
   * and the change stands (afterChange). A field it reads at another level is a
   * problem, like a slip.
   *
   * Throws, writing nothing, for an invalid policy, a placement it can't make,
   * a gate.json that can't be read or isn't JSON, one with no rule list it
   * could edit without writing over what it holds, one a start didn't use,
   * which runs as one without it does, while it's unchanged, or one the gate
   * doesn't use that the change doesn't mend or would leave with no rules in
   * force; and throws when the write fails, which may leave gate.json
   * part-written.
   */
  addPolicy(
    rawPolicy: unknown,
    options?: {
      position?: 'append' | 'prepend' | { before: string } | { after: string };
      onIgnoredFields?: (notes: string[]) => void;
    },
  ): GatePolicy {
    const reading = readRule(rawPolicy, 'A policy');
    if (reading.problems.length > 0 || !reading.policy) throw new Error(refusalOf(reading));
    const policy = reading.policy;
    const ignored = notesOf(reading);
    const edit = this.rulesForChange();
    if ('refused' in edit) throw new Error(edit.refused);
    const { top, rules, remedy } = edit;
    const idx = rules.findIndex((rule) => nameOf(rule) === policy.name);
    const position = options?.position;

    if (idx >= 0 && position === undefined) {
      rules[idx] = policy; // replace in place, order preserved
    } else {
      if (idx >= 0) rules.splice(idx, 1); // repositioning a known rule
      if (position === 'prepend') {
        rules.unshift(policy);
      } else if (position !== undefined && typeof position === 'object') {
        const anchorName = 'before' in position ? position.before : position.after;
        const anchorIdx = rules.findIndex((rule) => nameOf(rule) === anchorName);
        if (anchorIdx < 0) {
          throw new Error(
            `addPolicy: no policy named "${anchorName}" to anchor on — `
            + `have: [${rules.map(nameOf).filter((name) => name !== undefined).join(', ')}]`,
          );
        }
        rules.splice('before' in position ? anchorIdx : anchorIdx + 1, 0, policy);
      } else {
        rules.push(policy);
      }
    }

    this.writeConfig(top, rules, remedy);
    this.emitTrace({
      type: 'gate:policy-added',
      configPath: this.configPath,
      policyName: policy.name,
      replaced: idx >= 0,
      timestamp: Date.now(),
    });
    if (ignored.length > 0) {
      // A caller that doesn't take the notes still gets them said, in the log.
      const onIgnoredFields = options?.onIgnoredFields;
      if (onIgnoredFields) afterChange('onIgnoredFields', () => onIgnoredFields(ignored));
      else console.error(`[gate] ${ignored.join(' ')}`);
    }
    return policy;
  }

  /**
   * Remove a policy by name from gate.json and clear its live state. Any pending
   * debounce batch is sent once the removal is written and in force, as its
   * timer would have sent it, so buffered events aren't silently dropped
   * (clearStateFor). Freshest on-disk config is re-read first, and every other
   * rule is written back as it was written (see addPolicy). A name that isn't
   * a non-empty string names no rule, so it returns false, writing nothing,
   * whatever gate.json holds. Otherwise it throws, writing nothing, for a
   * gate.json that can't be read or isn't JSON, one with no rule list it could
   * edit, or one a start didn't use, as addPolicy does, and returns false,
   * writing nothing, if no policy of that name exists, gate.json's own rules
   * included, so one the gate leaves out can be removed by name too. For a name
   * it holds, it throws, writing nothing, for a gate.json the gate doesn't use
   * that the removal doesn't mend or would leave with no rules in force, and
   * throws when the write fails, which may
   * leave gate.json part-written; the rules in force then stay as they were,
   * with their state.
   */
  removePolicy(name: string): boolean {
    // nameOf gives undefined for a rule with no name, so a call from JavaScript
    // with no name would otherwise remove every such rule.
    if (typeof name !== 'string' || name === '') return false;
    const edit = this.rulesForChange();
    if ('refused' in edit) throw new Error(edit.refused);
    if (!edit.rules.some((rule) => nameOf(rule) === name)) return false;
    // The write clears the rule's state once it has succeeded (writeConfig),
    // so a refusal or a failed write leaves the rule in force with its state.
    this.writeConfig(edit.top, edit.rules.filter((rule) => nameOf(rule) !== name), edit.remedy);
    this.emitTrace({
      type: 'gate:policy-removed',
      configPath: this.configPath,
      policyName: name,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * List the current policy names: those of a newer gate.json that loads (the
   * freshest on-disk view), and otherwise the rules in force, which beside a
   * gate.json with no rule list are the host's starting rules. Cheap helper for
   * tools/UX that want to show what's active without the full status payload.
   */
  listPolicyNames(): string[] {
    const read = this.readConfigFile({ unlessUnchanged: true });
    const current = read.state === 'loaded' ? read.config : this.config;
    return current.policies.map((p) => p.name);
  }

  /**
   * Persist gate.json and apply it in memory together: `top`, its own fields,
   * with `rules` as its rule list. Only what loads is written: a change to a
   * gate.json the gate doesn't use, for which `remedy` is given, what would
   * bring it into force, throws, naming that and `remedy`, and writes nothing,
   * where the change doesn't mend what keeps it out, or where it would leave
   * gate.json with no rules in force: such a gate.json holds events back by
   * default, so putting it in force would hold back every event, those the
   * rules in force wake on included. The rules in force are then what the text
   * written reads as, as at a load, so what it still holds that the gate reads
   * past or leaves out stays named; the text is kept as `configText`, so
   * `reloadIfChanged` doesn't parse it again. Once the text is written and its
   * rules are in force, a rule that was in force that it leaves out or gives
   * another behavior loses its state (clearStateFor), last, since a pending
   * batch it sends can't be taken back, and a write that fails leaves the
   * rules in force with their state; a batch that can't be delivered is
   * logged, not thrown. A write that fails throws, saying whether gate.json was
   * changed: one that fails before writing leaves it as it was, and one that
   * fails after its open may leave it part-written (beforeWriting). Callers
   * surface it as a tool error.
   */
  private writeConfig(top: Record<string, unknown>, rules: unknown[], remedy?: string): void {
    const text = JSON.stringify({ ...top, policies: rules }, null, 2) + '\n';
    const read = readConfig(JSON.parse(text), 'gate.json');
    if ('refused' in read) {
      throw new Error(
        `Nothing was saved: with this change, gate.json wouldn't be used. ${sentence(read.refused)}${remedy ? ` ${remedy}` : ''}`,
      );
    }
    // One the gate doesn't use, and that a change can mend, holds back what a
    // rule it leaves out would wake on, so its default holds events back.
    if (remedy !== undefined && read.config.policies.length === 0) {
      throw new Error(
        'Nothing was saved: with this change, gate.json would have no rules the gate reads, and its default would hold back every '
        + `event. Meanwhile the gate runs ${this.rulesRun()}. ${remedy}`,
      );
    }
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, text);
    } catch (err) {
      throw new Error(beforeWriting(err)
        ? `gate.json couldn't be written (${errorText(err)}), so nothing was saved: the rules in force and gate.json stay `
          + 'as they were. Whoever runs this host can fix what keeps it from being written.'
        : `Writing gate.json failed partway (${errorText(err)}), so the change isn't in force: the rules in force stay as `
          + 'they were. gate.json may hold the whole change, which the gate reads at its next reload; or it may hold part of it '
          + 'or nothing, which the gate can\'t read, and then they stay until gate.json is fixed. '
          + 'Whoever runs this host can fix what kept it from being written, and check what gate.json holds.', { cause: err });
    }
    const was = this.config;
    this.configText = text;
    this.configNote = loadNote(read.sentences);
    this.config = read.config;
    this.compiledPolicies = this.compilePolicies(read.config);
    this.refreshShadowWarnings('policy-mutation');
    this.configSource = 'file';
    this.configError = this.configNote;
    this.configUnused = false;
    this.startUnsaved = null;
    this.lastReloadTimestamp = Date.now();
    this.clearStateFor(was, read.config);
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

    // Channel check: the event's own channel id, or the registered id the
    // gate resolves for its route. A push event carries the adapter's raw id
    // (`origin.channelId`, or none), and a channels/incoming message the
    // registered one, so a pattern in the registered form matches every
    // event in its channel whose push names the channel (by `mcplChannelId`,
    // or a Discord origin's guild and channel): its messages on both paths,
    // and its reactions, edits, voice reports and other pushes.
    if (compiled.channelRegex && !compiled.channelRegex.test(info.channelId)) {
      const registered = this.routeChannelFor(info);
      if (registered === undefined || !compiled.channelRegex.test(registered)) return false;
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
    // (the gate only governs inference triggering). The heartbeat is the
    // server the host knows as `heartbeat`, the server id the silent-heartbeat
    // marker requires too: a `source` in an event's metadata is the server's
    // own word, which any server can give.
    if (this.sleepUntil > this.now()) {
      const isHeartbeat = info.serverId === 'heartbeat';
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

  /** Resolve the partition key for keyBy-style behaviors. `keyBy:
   *  "channelId"` takes the registered id the gate resolves for the event when
   *  it has one, as channel matching does, so a channel's push events count
   *  with its channels/incoming messages rather than under their raw id. */
  private resolveKey(info: GateEventInfo, keyBy: string | undefined): string {
    if (!keyBy) return SHARED_BUCKET_KEY;
    if (keyBy === 'channelId') {
      const registered = this.routeChannelFor(info);
      if (registered !== undefined) return registered;
    }
    const value = info.metadata?.[keyBy];
    if (value === undefined || value === null || value === '') return SHARED_BUCKET_KEY;
    return String(value);
  }

  private applyRateLimit(
    policy: GatePolicy,
    info: GateEventInfo,
    config: { tokens: number; refillIntervalMs: number; keyBy?: string },
  ): GateDecision {
    const key = this.resolveKey(info, config.keyBy);
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
      // A refill interval of 0, read from gate.json or the starting rules
      // (readRateLimit), refills at once; divided by, it refilled the bucket
      // once and left its clock at NaN. Under 0, no number of whole intervals
      // has passed, so it never refills.
      if (config.refillIntervalMs === 0) {
        bucket.tokens = config.tokens;
        bucket.lastRefill = now;
      } else if (elapsed > 0) {
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
    const key = this.resolveKey(info, config.keyBy);
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
   * Clear one policy's live state (rate-limit buckets, passive-sample
   * counters, denial / fire counters) and stop its debounce timer, leaving
   * its pending batch for fireDebounce to send, as clearStateFor does once
   * every policy's state is cleared. It leaves stats (matchCount,
   * lastMatchTimestamp), which are history; clearStateFor deletes a removed
   * policy's.
   */
  private clearPolicyState(name: string): void {
    const debounce = this.debounceTimers.get(name);
    if (debounce) clearTimeout(debounce.timer);
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
        const key = this.resolveKey(info, cfg.keyBy);
        const bucket = this.rateLimitBuckets.get(policy.name)?.get(key);
        if (!bucket) return true; // fresh bucket starts full
        // As applyRateLimit refills: at once, for an interval of 0, and never
        // for one under 0.
        if (cfg.refillIntervalMs === 0) return true;
        let tokens = bucket.tokens;
        if (tokens < cfg.tokens && cfg.refillIntervalMs > 0) {
          const elapsed = Math.max(0, this.now() - bucket.lastRefill);
          tokens = Math.min(cfg.tokens, tokens + Math.floor(elapsed / cfg.refillIntervalMs));
        }
        return tokens > 0;
      }
      if ('passive_sample' in b) {
        const cfg = b.passive_sample;
        const key = this.resolveKey(info, cfg.keyBy);
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

  /** The canonical synthetic events the probe table runs: chat shapes as MCPL delivers them, and a heartbeat. */
  private probeEvents(): Array<{ label: string; info: GateEventInfo }> {
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
    return probes;
  }

  /**
   * The rules no probe event matches, such as one scoped to an event type
   * the probes don't model (`external-message`, how a module's messages are
   * gated): the probe table can't show what they do, so a result that shows
   * the table names them rather than let its rows read as their effect.
   */
  probeUnreached(): string[] {
    const events = this.probeEvents().map(({ info }) => info);
    return this.compiledPolicies
      .filter((compiled) => !events.some((info) => this.compiledMatches(compiled, info)))
      .map((compiled) => compiled.policy.name);
  }

  /**
   * Probe a canonical set of synthetic chat/heartbeat events and report which
   * rule wins each and whether it would wake. Backs the before/after table in
   * the wake_add_rule result — the point where a rule change's real semantics
   * must become legible (af#105; the Mythos stand-back-density incident would
   * have been visible as `dm: discord-direct-address → stand-back-density`).
   * Probes are representative shapes, not an exhaustive event space — rules
   * keyed on specific channels/mounts, or on other event types, may not match
   * any probe; `probeUnreached` names those.
   */
  probeTable(): GateProbeRow[] {
    return this.probeEvents().map(({ label, info }) => {
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
        ? safeSlice(info.content, 0, MAX_CONTENT_SNIPPET) + '...'
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
      ...(typeof info.metadata?.messageId === 'string' ? { messageId: info.metadata.messageId } : {}),
      ...(typeof info.metadata?.eventId === 'string' ? { eventId: info.metadata.eventId } : {}),
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

    // A delivery that throws drops the batch, named in the log: thrown from
    // its timer, it would be uncaught, and stop the process, and thrown to a
    // write or reload that sends it (clearStateFor), it would report a change
    // that was made as failed.
    try {
      this.deliverEvents(events);
    } catch (err) {
      const one = events.length === 1;
      console.error(
        `[gate] Policy "${policyName}": its pending batch of ${events.length} ${one ? 'event' : 'events'} couldn't be delivered `
        + `(${errorText(err)}), so the batch is dropped`,
      );
      return;
    }

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
    // How each referenced channel is named in the line, in order.
    const shown: string[] = [];
    if (referenced.length > 0) {
      // By channel, its server and its id: two servers' channels can share
      // an id.
      const byChannel = new Map<string, { name: string; count: number; oldest: number; label?: string }>();
      for (const e of referenced) {
        // The registered id when known, so this line names the channel the
        // same way routing notices and send tools do (a push event's own
        // channelId is the adapter's raw id), shown as the agent names it
        // back where the event names its server.
        // Only a registered id is a channel name; an adapter's raw id is
        // shown as it is.
        const id = e.routeChannelId ?? e.channelId;
        const name = id === undefined
          ? '(unknown channel)'
          : e.routeChannelId !== undefined && e.serverId !== undefined && this.channelShownFn
            ? this.channelShownFn({ serverId: e.serverId, channelId: e.routeChannelId })
            : id;
        const key = JSON.stringify([e.serverId ?? null, id ?? null]);
        const entry = byChannel.get(key) ?? { name, count: 0, oldest: e.timestamp, label: e.channelLabel };
        entry.count += 1;
        entry.oldest = Math.min(entry.oldest, e.timestamp);
        entry.label = entry.label ?? e.channelLabel;
        byChannel.set(key, entry);
      }
      for (const { name, count, oldest, label } of byChannel.values()) {
        // Prefer the human-readable name; keep the id parenthesized so the
        // agent can still address tools that want the composite id. A name
        // may carry its own `#`, so one is added only where the name lacks
        // it, as at the other places that add a `#`.
        const channel = label ? `${label.startsWith('#') ? label : `#${label}`} (${name})` : name;
        shown.push(channel);
        lines.push(referenceLine(count, channel, oldest, Date.now()));
      }
    }

    // The line says which messages a wake is for. For one message that is
    // still the newest thing in the window it would be written to, it says
    // nothing the message right above doesn't. But the turn compiles later,
    // and what lands in between puts the message above other entries, so the
    // gate hands the line to the wake (WakeProvenance.line) and a fresh start
    // of the wake's turn decides it (WakeLine). Several messages, one with
    // anything after it, or content the line quotes, keep the line now.
    const text = `[Gate: ${events.length} event${events.length > 1 ? 's' : ''} matched]\n\n${lines.join('\n')}`;
    const only = events.length === 1 && events[0].inContext ? events[0] : undefined;
    let line: WakeLine | undefined;
    if (only && this.newestEntry(only)) {
      const shownChannel = only.routeChannelId ?? only.channelId;
      line = {
        entry: entryRef(only),
        policyNames,
        shown: shown[0],
        at: only.timestamp,
        ...(shownChannel !== undefined ? { channelId: shownChannel } : {}),
      };
    } else {
      this.addMessageFn('user', [{ type: 'text', text }], {
        source: 'gate:debounce',
        policies: policyNames,
      });
    }

    // Provenance of the batched wake (who/where woke the agent): the newest
    // ADDRESSED event first, else the newest event naming a channel or an
    // author; channel + author + addressed from that ONE event. When that
    // event addressed the agent and its registered channel is known,
    // `routeChannelId` names the turn's speech locus too — the reply goes
    // back to whoever addressed the agent, not to whichever channel last saw
    // any traffic. Ambient-only batches set no locus. A batch whose line the
    // gate left to the turn's start carries it too (`line`), one object
    // shared by every agent the batch wakes, so it is written once.
    const chosen = wakeProvenance(events);
    const provenance = line ? { ...chosen, line } : chosen;
    for (const agentName of this.getAgentNamesFn()) {
      this.requestInferenceFn(agentName, 'gate:debounce', 'gate', provenance);
    }
  }

  /** isNewestEntry for one event; a callback fault keeps the line. */
  private newestEntry(event: PendingEvent): boolean {
    if (!this.isNewestEntryFn) return false;
    try {
      return this.isNewestEntryFn(entryRef(event)) === true;
    } catch {
      return false;
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

  /** A turn that continues another (a budget restart, a tool-result-guard
   *  retry) holds the entry its predecessor kept for it, and takes it again
   *  where that entry ended in between: at a stop(), whose dispose() clears
   *  every entry, or at a provider hold that kept the turn from starting,
   *  whose end queues it again. Unlike onInferenceStarted it leaves a
   *  pending self-wake alone: the logical turn that armed it is the one
   *  still running. */
  onInferenceResumed(agentName: string): void {
    this.inferring.add(agentName);
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
      // Defer to avoid re-entrancy inside trace callbacks. A delivery that
      // throws drops what was held, named in the log, as fireDebounce drops a
      // batch: thrown in the microtask, it would be uncaught.
      queueMicrotask(() => {
        try {
          this.deliverEvents(events);
        } catch (err) {
          const one = events.length === 1;
          console.error(
            `[gate] ${events.length} ${one ? 'event' : 'events'} held for an agent's turn or the host's quiesce couldn't be `
            + `delivered (${errorText(err)}), so ${one ? "it's" : "they're"} dropped`,
          );
        }
      });
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
    // tick or an incoming message). Cancelled by clearSleep()/`wake`, and by
    // dispose(), after which start() arms it again (resumeSleep).
    this.armSleepWake();
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

  /**
   * Arm timers again for a lifecycle that starts after a stop(), and the
   * sleep's wake first: dispose() clears its timer and keeps the sleep. A
   * sleep still ahead wakes the agent at its end; one that ended while
   * stopped wakes it now, since that wake is what the agent asked for. With
   * no sleep, wakeFromSleep does nothing.
   */
  resumeSleep(): void {
    this.disposed = false;
    if (this.sleepUntil > this.now()) this.armSleepWake();
    else this.wakeFromSleep('sleep-expired');
  }

  /**
   * Arm the sleep's wake for its end by the gate's own clock. One timer holds
   * at most MAX_TIMER_MS, about 24.8 days, so a longer sleep waits in steps,
   * and wakeFromSleep reads the clock as each one fires. Nothing is armed
   * while the gate is disposed: resumeSleep() arms it at the next start().
   */
  private armSleepWake(): void {
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    if (this.disposed) return;
    const remaining = Math.max(0, this.sleepUntil - this.now());
    this.sleepTimer = setTimeout(() => this.wakeFromSleep('sleep-expired'), Math.min(remaining, MAX_TIMER_MS));
  }

  /**
   * `agentName` is gone, as a conversation fork's end or an ephemeral run's
   * removes one: its pending self-wake is cancelled, and a sleep it set ends.
   * The gate's sleep holds back every agent's wakes, so nobody is asleep once
   * its agent is gone, and neither wake would reach a name that no longer
   * exists. A sleep another agent set, or one set with no agent, stays.
   */
  agentGone(agentName: string): void {
    const selfWake = this.selfWakeTimers.get(agentName);
    if (selfWake) {
      clearTimeout(selfWake);
      this.selfWakeTimers.delete(agentName);
    }
    if (this.sleepUntil !== 0 && this.sleepAgent === agentName) this.clearSleep();
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
  armSelfWake(agentName: string, seconds: number, source = 'skip_reply'): { inMs: number; armed: boolean } {
    const ms = Math.max(1_000, Math.min(3_600_000, Math.floor(seconds * 1000)));
    // A stopped framework's late turn arms no timer (disposed). A self-wake
    // doesn't outlive a stop, as dispose() clearing the pending ones says.
    if (this.disposed) return { inMs: ms, armed: false };
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
      // narrate itself into the primary's context. Its wake goes with it: an
      // agent that heard the notice during a turn was awake when its timer
      // fired, and the host drops the wake once a request that carried the
      // notice is answered.
      const placement: WritePlacement = {};
      this.addMessageFn('user', [{
        type: 'text',
        text: `[self-wake] your ${source} timer (${Math.round(ms / 1000)}s) elapsed — now ${nowIso}`,
      }], { source: 'gate:self-wake' }, agentName, placement);
      this.requestInferenceFn(
        agentName,
        `self-scheduled wake (${source}, ${Math.round(ms / 1000)}s)`,
        'self-wake',
        undefined,
        placement,
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
    return { inMs: ms, armed: true };
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
   * `wake`). A timer that fires before the sleep's end by the gate's clock
   * arms the rest: a step of a sleep longer than one timer holds, a timer that
   * fires early (Node's can, by a millisecond), or a clock set back.
   */
  private wakeFromSleep(reason: string): void {
    // The timer that called it has fired; from resumeSleep(), for a sleep
    // already over, one may still be armed, and it goes, so no stale step of
    // it can fire later.
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    if (this.sleepUntil === 0) return;
    if (this.sleepUntil > this.now()) {
      this.armSleepWake();
      return;
    }
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
      const parsed: unknown = parseGateJson(raw);
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
      errors: [this.configErrorShown(), this.startNotice, this.startUnsaved, this.privilegedError]
        .filter((e): e is string => e !== null),
      shadowWarnings: this.shadowWarningsCache.map(formatShadowWarning),
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
    // The sleep stays, with its note and agent, and its timer goes: fired
    // after a stop(), its wake reached a framework that had stopped, and the
    // timer held the process until the sleep's end. The next start() arms it
    // again (resumeSleep). Until then nothing arms one, nor a self-wake: a
    // turn a failed stop() left running can still call sleep or skip_reply.
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    this.disposed = true;
    this.rateLimitBuckets.clear();
    this.passiveSampleCounters.clear();
    this.rateLimitDenied.clear();
    this.passiveSampleFires.clear();
    this.inferenceBuffer = [];
    // stop() disposes the gate once its streams and event loop have ended (a
    // turn still compiling then is dropped at its next check, before it sends
    // anything), and a start() goes on with this gate. An agent left here by
    // a turn whose exit didn't end it (a retry stop() cancelled, a successor
    // stop() refused) would make every debounced batch buffer until that
    // agent's next turn ended. A turn that continues after the start() takes
    // its entry again (onInferenceResumed). A start() made during the stop()
    // is refused, so no turn of a new lifecycle can have begun before this
    // runs.
    this.inferring.clear();
  }
}
