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

import { chmodSync, chownSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GateScript } from './gate-script.js';
import { closestNames, isNearMiss } from '../closest-names.js';
import { safeSlice } from '../safe-slice.js';

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
// Reading rules
// ---------------------------------------------------------------------------

// A rule is read as written when it can be, and every problem it has is named.
// gate.json and the host's starting rules are what a deployment already runs,
// so a rule with a problem is read the way earlier releases read it, and no
// event that woke the agent there goes quiet: a behavior the gate doesn't know
// is read as "always"; a field of the wrong type, one slip from one the gate
// reads there, or one the gate reads at another level of the rule (a match's
// "tagsAny" beside "name"), as left out, its problem naming where it's read;
// and a number out of range the way the starting rules ran it. A rule is left
// out only where earlier releases refused it. One that skips or defers is read
// past a problem too, holding back what they held back: left out, the events
// it held back would go on to the rules after it, where a rate limit, a sample
// or a debounce could spend them and then hold back an event that woke the
// agent before. Under a default that holds events back, a file that leaves out
// a rule that could wake the agent isn't used, since that would hold back what
// the rule was written to wake on; earlier releases didn't use it either. A
// change through addPolicy, whose caller is there to fix it, refuses any
// problem, and nothing is saved. A field name that is no slip of one the gate
// reads there, and that it reads at no other level, changes nothing, a slip of
// another level's field included: it loads, and a note names it with the
// fields its place holds. A "policies" holding nothing, or a slip of it that
// does, writes no rules, as one left out does. Where "policies" writes no
// rules, a list holding an object with a field of a rule, or of its match or
// behavior, under a name gate.json doesn't read, is read as a slip of
// "policies", and under a default that holds events back, such a field at
// gate.json's top is read the same way. A rule's name, a filter's type and a
// keyBy shape nothing on their own, so a label of the file can have their
// names, and nor does a field of a rule or its match holding nothing, since
// an empty one has always meant no constraint; a behavior names what a rule
// does, even holding nothing.
// A null is a field left out, and so is "", with a note: earlier releases read
// most fields that way, and none narrows anything by them. Where they refused
// a rule or a file for one (a passthrough, a behavior's kind, gate.json's
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
// Fields of a rule that shape nothing on their own: a rule's name, a filter's
// type without its pattern, and a keyBy without the tokens or every it groups.
const LABEL_FIELDS = ['name', 'type', 'keyBy'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A value that sets nothing: null, "", an empty list, or an object holding only such values. */
function holdsNothing(value: unknown): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0)
    || (isPlainObject(value) && Object.values(value).every(holdsNothing));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * writing over what it holds (a list, JSON that isn't an object, or a
 * "policies" that isn't a list and holds something), or leaving it out of
 * force (rules under a slip of "policies", or a rule's fields at the top,
 * beside which a list would bring only the new rule into force).
 */
function noListRefusal(noList: string): string {
  return `${noList}, so a change has no list of rules to edit without writing over or leaving out what gate.json holds, `
    + 'and nothing was saved. Whoever runs this host can make gate.json an object whose "policies" is a list holding its '
    + 'rules; until then, a change is refused the same way.';
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

/** An object's field names that the gate doesn't read in its place: slips of one it does, and the rest. */
function fieldNames(obj: Record<string, unknown>, fields: readonly string[]): { slips: Slip[]; unread: string[] } {
  const slips: Slip[] = [];
  const unread: string[] = [];
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || fields.includes(key)) continue;
    const near = fields.filter((field) => isNearMiss(key, field));
    if (near.length === 0) {
      unread.push(key);
      continue;
    }
    // closestNames keeps every name isNearMiss accepts, in its order.
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
 * with what leaving it out does where `means` says), a near-miss of a
 * parameter is refused, naming the one meant, and so is a field of one of its
 * object parameters given on its own, naming that parameter; any other name is
 * noted, or named in that refusal. Returns the input without what was left out.
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
    throw new Error(
      `${tool} has ${has.join(', and ')}, so nothing was saved. ${TOOL_PARAMETERS_TERMS.listed} ${quotedList(params)}.`,
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
   *  skips or defers, or it's a rate limit with no tokens. Left out, such a
   *  rule holds back nothing it was written to wake on. */
  quiet: boolean;
  /** Every problem it has, in the order its fields are read. */
  problems: RuleProblem[];
  /** Its fields that do nothing, and those given as "", each a sentence. */
  notes: string[];
  /** Set where it would be in force, and nothing left in its match narrows it. */
  matchesAll?: boolean;
}

/**
 * A rule's notes, ending with what a match that narrows nothing does; a
 * refusal says what it would do as written, since nothing was saved.
 */
function notesOf(reading: RuleReading, refused = false): string[] {
  if (!reading.matchesAll) return reading.notes;
  const does = refused ? 'as written it would match' : 'it matches';
  return [...reading.notes, `${reading.where}: nothing left in match narrows the rule, so ${does} every event.`];
}

/** Where a rule's fields are read into: the rule's name in messages, its problems, and its notes. */
interface Reader {
  where: string;
  /** How messages name the file the rule is in, for a field of the file's own put in the rule. */
  file: string;
  problems: RuleProblem[];
  notes: string[];
  /** Set where its rate limit has no tokens, so it wakes on none of what it matches. */
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
 * object holding one of the timing kinds. Anything else but a list was read as
 * "always", a rule that wakes on every event it matches, and is read so. Of
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
 * A debounce: a number of milliseconds. One out of the gate's range ran as
 * written, which never silenced an event, so it's read at its nearest bound,
 * which keeps what the rule meant.
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
 * one of 0 refilled it once, then never, its clock left at NaN; both are read
 * as never refilling (applyRateLimit). No tokens woke on none of it, so such
 * a rule is left out.
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
      read: "so its tokens never refill, and once they're spent it wakes the agent on nothing it matches",
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
     *  a "policies" that isn't one and holds something, or, where "policies"
     *  writes no rules, a slip of it holding something), what it is instead. */
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
 * messages). Earlier releases refused it whole where it isn't an object, or
 * its default isn't one of the three, and it isn't used. A list, a
 * "policies" that isn't a list and holds something, or, where "policies"
 * writes no rules, a slip of it holding something, they read as no rules
 * under its default, which is read so where that wakes ("always"), and
 * otherwise isn't used. A "policies" holding nothing, an empty list or one
 * that isn't a list, writes no rules, as one left out does, and so does a
 * slip of it holding nothing. Where "policies" writes no rules, a list under
 * a name the gate doesn't read, holding an object with a field that says a
 * rule was meant (meansRule), is read as such a slip, since its author meant
 * rules, and under a default that holds events back, a field at the file's
 * top that says a rule was meant isn't used either.
 * Each rule is read on its own. Under a default that holds events back, a
 * rule left out that could wake the agent would hold back what it was written
 * to wake on, so the file isn't used, as earlier releases, which refused such
 * a rule and so the file, didn't use it.
 */
function readConfig(raw: unknown, file: 'gate.json' | 'the starting config'): ConfigReading {
  const File = file === 'gate.json' ? file : 'The starting config';
  const noRules = 'so it has no rules, and every event gets the default, "always"';
  if (Array.isArray(raw)) {
    return {
      config: { policies: [], default: 'always' },
      rules: [],
      sentences: [
        `${File} is a list, where an object is needed, such as {"policies": [{"name": "my-rule", "behavior": "always"}]}, `
        + 'so none of it is read, and every event gets the default, "always".',
      ],
      listed: { noList: `${File} is a list` },
    };
  }
  if (!isPlainObject(raw)) return { refused: `${file} must be a JSON object`, listed: { noList: `${File} is ${shownValue(raw)}` } };

  const sentences: string[] = [];
  const obj = withoutEmpty(file, raw, sentences, configLeftOut(raw.default));
  const names = fieldNames(obj, CONFIG_FIELDS);
  // A field of a rule, or of its match or behavior, says a rule was meant, but
  // for a label's names, which shape nothing on their own, and a field of a
  // rule or its match holding nothing, since an empty one has always meant no
  // constraint. A behavior, one of its kinds or their fields counts even
  // holding nothing, since it names what a rule does: a rule left out with a
  // behavior that's a list or names no kind, or a rate limit without tokens,
  // counts as one that could wake the agent too. A null or "" is a field left
  // out, in a list's objects as everywhere else, so it says nothing.
  const elsewhere = homesOf(file, CONFIG_FIELDS);
  const ofBehavior = (key: string): boolean =>
    key === 'behavior' || elsewhere(key).some((home) => home.startsWith('"behavior'));
  const meansRule = (key: string, value: unknown): boolean => !LABEL_FIELDS.includes(key) && elsewhere(key).length > 0
    && (ofBehavior(key) ? value !== null && value !== '' : !holdsNothing(value));
  // A "policies" holding nothing writes no rules, as one left out does, so
  // what gate.json holds beside it is read as it is with none.
  const noPolicies = obj.policies === undefined || holdsNothing(obj.policies);
  // There, a list holding an object with such a field, under a name the gate
  // doesn't read, says its author meant rules, so it's read as a slip of
  // "policies", whatever the name.
  const ruleLists = noPolicies
    ? names.unread.filter((key) => Array.isArray(obj[key]) && (obj[key] as unknown[]).some((item) => isPlainObject(item)
      && Object.entries(item).some(([field, value]) => meansRule(field, value))))
    : [];
  const slips: Slip[] = [...names.slips, ...ruleLists.map((key) => ({ key, meant: ['policies'] }))];
  const { misplaced, rest } = placedElsewhere(names.unread.filter((key) => !ruleLists.includes(key)), elsewhere);
  noteUnread(file, rest, CONFIG_FIELDS, sentences);
  for (const m of misplaced) {
    sentences.push(
      `${file} has ${misplacedShown(m)}, which the gate doesn't read here, so ${m.keys.length === 1 ? 'it does' : 'they do'} nothing.`,
    );
  }
  // So does such a field at the file's top, where "policies" writes no rules.
  // Under a default that holds events back, read as written the file would
  // hold back what that rule was written to let through, so there it isn't
  // used, as a slip of "policies" isn't.
  const ruleAtTop = noPolicies && (obj.default === 'skip' || obj.default === 'defer')
    && misplaced.some((m) => m.keys.some((key) => meansRule(key, obj[key])))
    ? `${File} has ${misplaced.map(misplacedShown).join(', and ')}, which the gate doesn't read here`
    : undefined;
  // A slip of "policies" holding nothing writes no rules either.
  const holdsRules = (slip: Slip): boolean => slip.meant.includes('policies') && !holdsNothing(obj[slip.key]);
  // What a change edits, used or not: its own fields and rule list as written
  // (a list left out, null or "", or one holding nothing, is an empty one), or
  // what it is instead. Where "policies" writes no rules, a slip of it holding
  // something holds rules the gate doesn't read, so there's no list to edit
  // there, nor beside a rule's field at its top.
  const policiesSlip = noPolicies ? slips.find(holdsRules) : undefined;
  const listed: Listed = policiesSlip
    ? { noList: `${File} has ${slipShown(policiesSlip)}, which the gate doesn't read` }
    : ruleAtTop
      ? { noList: ruleAtTop }
      : noPolicies || Array.isArray(obj.policies)
        ? { top: raw, rules: Array.isArray(obj.policies) ? obj.policies : [] }
        : { noList: `${File}'s "policies" is ${shownValue(obj.policies)}` };
  const given = obj.default;
  if (given !== undefined && given !== 'always' && given !== 'defer' && given !== 'skip') {
    return { refused: `${file} "default" must be "always", "defer", or "skip", got: ${shownValue(given)}`, listed };
  }
  const defaultBehavior = given ?? 'always';
  const withoutRules = (text: string): string => `${text}, and with no rules its default, "${defaultBehavior}", would hold back every event.`;
  for (const slip of slips) {
    const text = `${File} has ${slipShown(slip)}, which the gate doesn't read`;
    let read = SLIP_READ;
    if (holdsRules(slip) && noPolicies) {
      if (defaultBehavior !== 'always') return { refused: withoutRules(text), listed };
      read = noRules;
    } else if (slip.meant.includes('policies') && noPolicies) {
      // One holding nothing is "policies" left out.
      read = `and ${configLeftOut(defaultBehavior).policies}`;
    } else if (slip.meant.includes('default') && obj.default === undefined) {
      read = 'so its default is "always"';
    }
    sentences.push(`${text}, ${read}.`);
  }
  if (ruleAtTop) return { refused: withoutRules(ruleAtTop), listed };
  const policies: unknown[] = Array.isArray(obj.policies) ? obj.policies : [];
  if (!Array.isArray(obj.policies) && obj.policies !== undefined) {
    const text = `${File}'s "policies" is ${shownValue(obj.policies)}, where a list of rules is needed, such as `
      + '[{"name": "my-rule", "behavior": "always"}]';
    if (noPolicies) sentences.push(`${text}, and ${configLeftOut(defaultBehavior).policies}.`);
    else if (defaultBehavior !== 'always') return { refused: withoutRules(text), listed };
    else sentences.push(`${text}, ${noRules}.`);
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

/** The host's starting rules (initialConfig), read as gate.json is, for the seed and the reconcile. */
interface StartingRules {
  /** Why none of them is used, when that's so. */
  refusedWhole?: string;
  /** What they put in force when gate.json can't be loaded: each rule not left out, as read. */
  config?: GateConfig;
  /** With `config`, the starting config as given, which a first start writes,
   *  since gate.json is read the same way. */
  given?: unknown;
  /** Each starting rule as given, with its name when it has one, for the reconcile to add by name. */
  rules: Array<{ name: string | undefined; raw: unknown }>;
  /** What the gate says of them, each a sentence. */
  sentences: string[];
}

function readStartingRules(raw: unknown): StartingRules {
  const read = readConfig(raw, 'the starting config');
  if ('refused' in read) return { refusedWhole: read.refused, rules: [], sentences: [] };
  return {
    config: read.config,
    given: raw,
    rules: read.rules.map((rule) => ({ name: nameOf(rule.raw), raw: rule.raw })),
    sentences: read.sentences,
  };
}

/** What a start's write of the host's starting rules to gate.json did. */
type StartWrite =
  | { kind: 'none' }
  /** A first start's write of the starting rules threw: at its open, or partway. */
  | { kind: 'seed-failed'; error: string; atOpen: boolean }
  /** A later start's write of the rules it read plus the ones it was adding threw, or couldn't be made; `config` is what it was writing. */
  | {
    kind: 'reconcile-failed'; names: string[]; error: string; atOpen: boolean; config: GateConfig;
    /** The text it was writing, whose reading is `config`, and what a load of it says, when the write itself failed. */
    text?: string;
    note?: string | null;
    sentences?: readonly string[];
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
    // own left it unable to load.
    const instead = held !== null || write.kind === 'reconcile-failed'
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
        + "so they weren't put in force.",
      );
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * What gate_status says when a start's own write left the rules in force
 * unsaved: a first start's seed that failed, or a reconcile whose write left
 * gate.json unable to load. It goes once gate.json is written, or a reload
 * applies its text or finds it holding the text in force.
 */
function describeUnsaved(starting: StartingRules, write: StartWrite): string | null {
  if (write.kind === 'seed-failed') {
    return write.atOpen
      ? `At start, gate.json couldn't be created (${write.error}), so the host's starting rules are in force but aren't saved in it.`
      : `At start, writing the host's starting rules to gate.json failed partway (${write.error}), so gate.json may be left `
        + "part-written. The starting rules are in force but aren't saved in it.";
  }
  if (write.kind === 'reconcile-failed') {
    const what = write.atOpen
      ? `the host's starting rules ${quotedList(write.names)} couldn't be added to gate.json (${write.error}), and gate.json `
        + "couldn't be loaded after that"
      : `adding the host's starting rules ${quotedList(write.names)} to gate.json failed partway (${write.error}), so gate.json `
        + 'may be left part-written';
    // What those rules hold that the gate reads past or leaves out, since
    // gate.json's own entry is now its load error.
    const read = write.sentences?.length ? `, read as a load reads them: ${write.sentences.join(' ')}` : '.';
    return `At start, ${what}. The gate runs the rules it read from gate.json and the ones it was adding, which aren't saved${read} `
      + `A restart before gate.json is fixed starts from ${starting.config ? "the host's starting rules" : 'no rules'}.`;
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

/** What a wake-rule tool tells the agent when its change kept a copy of an unreadable gate.json. */
export function formatUnreadableKept(kept: UnreadableConfigKept): string {
  return `gate.json couldn't be used (${kept.reason}), so a copy of it was kept at ${kept.keptPath}, and gate.json `
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
   *  (or the start's reconcile, whose write failed).
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

    // Seed or reconcile the on-disk config from the host's starting rules
    // (`initialConfig`), which are read as gate.json is, rule by rule: a rule
    // with a problem is read past it, or left out (readConfig).
    //
    // First start: write `initialConfig` as given, since gate.json is read the
    // same way. Subsequent starts: if the recipe/config source declares
    // policies whose names gate.json doesn't hold (e.g. the user edited the
    // recipe between sessions), append them, as given, to its rule list.
    // Existing policies are left alone, the ones the gate leaves out included,
    // so user edits via `workspace--edit _config/gate.json` survive.
    // The `default` field is not reconciled — it's an explicit operator
    // choice and a recipe change shouldn't silently flip live wake
    // behavior for a session that's already been running.
    const initial = opts.initialConfig;
    const starting = initial !== undefined ? readStartingRules(initial) : undefined;
    const write: StartWrite = starting ? this.seedOrReconcile(starting) : { kind: 'none' };

    // Load config: gate.json; without it, the starting rules as read, unless
    // none of them is used; and otherwise no rules, as a host without any has. When a
    // reconcile's own write left gate.json unable to load, the gate runs what
    // that write held, the rules it read plus the ones it was adding, since a
    // failed write of ours shouldn't take rules out of force.
    const read = this.readConfigFile();
    if (read.state === 'loaded') {
      this.config = read.config;
      this.configText = read.text;
      this.configNote = read.note;
      this.configSource = 'file';
      if (read.note) console.error(`[gate] ${read.note}`);
    } else if (write.kind === 'reconcile-failed') {
      this.config = write.config;
      // Its text is what a change then edits, so every rule it holds keeps its name.
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
      this.startNotice = describeStart(starting, write, read.state === 'loaded' ? heldNames(read.listed) : null);
      this.startUnsaved = read.state === 'loaded' ? null : describeUnsaved(starting, write);
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

  private loadConfig(): GateConfig | null {
    const read = this.readConfigFile();
    return read.state === 'loaded' ? read.config : null; // Caller keeps previous config
  }

  /**
   * Write the starting rules to gate.json, as given, when it's absent, or add
   * the ones it lacks by name, as given, to its own rule list when it loads.
   * A rule gate.json holds holds its name, whether the gate reads it or leaves
   * it out, so an operator's rule is never swapped for the host's. Says what
   * it did when that wasn't simply done or not needed.
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
      return { kind: 'none' };
    }
    if (read.state !== 'loaded') return { kind: 'none' };
    const held = heldNames(read.listed);
    const missing = starting.rules.filter((rule): rule is { name: string; raw: unknown } => rule.name !== undefined && !held.has(rule.name));
    if (missing.length === 0) return { kind: 'none' };
    const names = missing.map((rule) => rule.name);
    if ('noList' in read.listed) {
      // Nothing was written, so gate.json loads as it did, without them.
      return {
        kind: 'reconcile-failed', names, atOpen: true, config: read.config,
        error: `${read.listed.noList}, so there's no list of rules to add them to without writing over or leaving out what it holds`,
      };
    }
    const reconciled = { ...read.listed.top, policies: [...read.listed.rules, ...missing.map((rule) => rule.raw)] };
    // What the write holds, as a load reads it, for a write that fails partway.
    const holds = readConfig(reconciled, 'gate.json');
    if ('refused' in holds) {
      // A write of ours doesn't take gate.json out of force: nothing is
      // written, so it loads as it did, without them.
      return {
        kind: 'reconcile-failed', names, atOpen: true, config: read.config,
        error: 'with them, gate.json would leave out a rule that could wake the agent, and under its default, '
          + `"${read.config.default ?? 'always'}", it wouldn't be used`,
      };
    }
    const text = JSON.stringify(reconciled, null, 2) + '\n';
    try {
      writeFileSync(this.configPath, text);
    } catch (err) {
      return {
        kind: 'reconcile-failed',
        names,
        error: errorText(err),
        atOpen: beforeWriting(err),
        config: holds.config,
        text,
        note: loadNote(holds.sentences),
        sentences: holds.sentences,
      };
    }
    this.emitTrace({
      type: 'gate:config-reconciled',
      configPath: this.configPath,
      addedPolicies: names,
      timestamp: Date.now(),
    });
    return { kind: 'none' };
  }

  /**
   * gate.json as it is on disk: absent; loaded; refused, when it's JSON that
   * readConfig doesn't use; or unreadable, when it can't be read or isn't
   * JSON, with its bytes when it could be read, since text decoded from a file
   * that isn't UTF-8 isn't what it held. A loaded file comes with its note,
   * which names what it holds that does nothing or is read past a problem, and
   * a loaded or refused one with its own fields and rule list as written, for a
   * write to edit (Listed).
   * Reading applies nothing: whoever applies a loaded config records its text
   * as `configText`. With `unlessUnchanged`, a file whose text is
   * `configText` comes back `unchanged`, unparsed, since the rules in force
   * came from it.
   */
  private readConfigFile(opts?: { unlessUnchanged?: boolean }):
    | { state: 'absent' }
    | { state: 'unchanged' }
    | { state: 'loaded'; config: GateConfig; text: string; note: string | null; listed: Listed }
    | { state: 'refused'; error: string; listed: Listed; silenced?: Array<string | undefined> }
    | { state: 'unreadable'; error: string; bytes?: Buffer } {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.configPath);
    } catch (err) {
      if (!isMissing(err)) return this.configUnreadable(err);
      // No file is no problem with it: the rules in force stay.
      this.configError = null;
      this.configUnused = false;
      return { state: 'absent' };
    }
    const raw = bytes.toString('utf-8');
    if (opts?.unlessUnchanged && raw === this.configText) {
      // The file holds the text in force, so its error is that text's notes,
      // whatever a failed read or a look at other text since left there.
      this.configError = this.configNote;
      this.configUnused = false;
      return { state: 'unchanged' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ...this.configUnreadable(err), bytes };
    }
    const read = readConfig(parsed, 'gate.json');
    // JSON the gate doesn't use is still the operator's file, edited as written.
    if ('refused' in read) {
      return { ...this.configUnreadable(new Error(read.refused)), state: 'refused', listed: read.listed, silenced: read.silenced };
    }
    // A field the gate doesn't read does nothing, and a rule is read past a
    // problem or left out, so the file loads, and each is named.
    const note = loadNote(read.sentences);
    this.configError = note;
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
    // Rules from a gate.json text, with the start's unsaved: only a start
    // whose reconcile write left gate.json unable to load runs those, since a
    // write of gate.json that lands, or a reload that finds it holding the text
    // in force or a text that loads, clears startUnsaved.
    const runs = this.configSource === 'file'
      ? this.startUnsaved !== null
        ? 'the rules it read from gate.json at start and the ones it was adding'
        : 'the rules of the last gate.json it used'
      : this.configSource === 'initial'
        ? "the host's starting rules"
        : 'no rules: every event gets the default, "always"';
    return `${sentence(this.configError)} So what gate.json holds isn't in force, and the gate runs ${runs}.`;
  }

  /**
   * What a policy change edits: gate.json's own fields and rule list as
   * written, each rule as written, so a write keeps every rule it doesn't
   * change, problems and unknown fields included, whether gate.json loads or
   * is JSON the gate doesn't use. Over one it doesn't use, writeConfig writes
   * only what loads, so a change is refused, naming what keeps the file out
   * and what would bring it into force (`remedy`), unless it mends that, and
   * the file stays as its operator wrote it. When
   * gate.json is absent, or can't be read or isn't JSON, the same of the text
   * whose rules are in force, so a rule it leaves out keeps its name; or the
   * rules in force, where no text is or it has no rule list. A file that can't
   * be read or isn't JSON comes back with its error, and with its bytes when
   * it could be read, for keepUnreadableConfig before anything is written over
   * it. A gate.json with no rule list a write could edit comes back as what
   * it is instead: a list, a "policies" that isn't one and holds something,
   * where "policies" writes no rules, a slip of it holding something or, under
   * "skip" or "defer", a field at its top that says a rule was meant, or JSON
   * that isn't an object.
   */
  private rulesForChange():
    | { top: Record<string, unknown>; rules: unknown[]; unreadable?: { error: string; bytes?: Buffer }; remedy?: string }
    | { noList: string } {
    const read = this.readConfigFile();
    if (read.state === 'loaded' || read.state === 'refused') {
      if ('noList' in read.listed) return read.listed;
      const edit = { top: read.listed.top, rules: [...read.listed.rules] };
      if (read.state === 'loaded') return edit;
      // What would bring it into force, for a change that doesn't. A change
      // finds its rule by name: a replacement takes the first rule with it,
      // and a removal every one.
      const names = [...new Set(read.silenced ?? [])];
      const only = names.length === 1 ? names[0] : undefined;
      const sharing = only === undefined ? 0 : edit.rules.filter((rule) => nameOf(rule) === only).length;
      return {
        ...edit,
        remedy: sharing === 1
          ? `Replacing or removing "${only}" by name would bring gate.json into force.`
          : sharing > 1
            ? `gate.json has ${sharing} rules named "${only}", and a change by that name replaces the first of them or removes them all.`
            : 'No change through the gate can bring it into force, so whoever runs this host has to fix gate.json; '
              + 'until then, a change is refused the same way.',
      };
    }
    const text = this.configText !== undefined ? readConfig(JSON.parse(this.configText), 'gate.json') : undefined;
    const inForce = text && !('refused' in text) && !('noList' in text.listed)
      ? { top: text.listed.top, rules: [...text.listed.rules] }
      : { top: { policies: [], default: this.config.default ?? 'always' }, rules: [...this.config.policies] as unknown[] };
    if (read.state === 'unreadable') return { ...inForce, unreadable: { error: read.error, bytes: read.bytes } };
    return inForce;
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
      throw new Error(
        `gate.json couldn't be read (${reason}), so it can't be kept, and nothing was written over it. Whoever runs this `
        + 'host can make gate.json readable; until then, a change is refused the same way.',
      );
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
          `gate.json couldn't be used (${reason}), and keeping a copy of it at ${kept} failed (${e.message ?? String(err)}), `
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
      console.error(`[gate] ${this.configPath} couldn't be used (${reason}); kept a copy at ${kept} before writing the rules in force`);
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
      .map((name) => `${join(dir, name)}: a copy of gate.json, kept when it couldn't be used. Nothing in it is in force. `
        + "To use it, fix it and copy it over gate.json. Once it isn't needed, remove it.");
  }

  /**
   * writeConfig, after keepUnreadableConfig may have kept a copy of gate.json:
   * then a write that fails names the copy, since what the file held may now
   * be only there.
   */
  private writeConfigAfterKeep(
    top: Record<string, unknown>, rules: unknown[], kept: UnreadableConfigKept | undefined, remedy?: string,
  ): void {
    try {
      this.writeConfig(top, rules, remedy);
    } catch (err) {
      if (!kept) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${sentence(msg)} A copy of what gate.json held when it couldn't be used is kept at ${kept.keptPath}.`, { cause: err });
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

  /**
   * Clear the state of each rule `was` held in force that `next` leaves out or
   * gives another behavior: a reload calls it before it puts `next` in force,
   * a write after. Without this, a rule that came back, or whose tokens 100
   * became 5 (or keyBy switched, or every 10 became 3), would run on the
   * buckets and counters of the rule it was. A rule left out loses its stats
   * (matchCount, lastMatchTimestamp) too; a rule kept keeps them, which are
   * history, not live state, and one kept with the same behavior keeps all its
   * state, its denial and fire counts included. Each pending debounce batch is
   * sent last, as its timer would have sent it, once every rule's state is
   * cleared, so a delivery that throws leaves no state behind and keeps no
   * other batch from being sent.
   */
  private clearStateFor(was: GateConfig, next: GateConfig): { removed: string[]; cleared: string[] } {
    const behaviorByName = new Map<string, string>();
    for (const p of was.policies) behaviorByName.set(p.name, behaviorFingerprint(p.behavior));
    const nextNames = new Set(next.policies.map((p) => p.name));
    const removed: string[] = [];
    for (const name of behaviorByName.keys()) {
      if (!nextNames.has(name)) {
        this.clearPolicyState(name);
        this.stats.delete(name);
        removed.push(name);
      }
    }
    const cleared: string[] = [];
    for (const p of next.policies) {
      const before = behaviorByName.get(p.name);
      if (before !== undefined && before !== behaviorFingerprint(p.behavior)) {
        this.clearPolicyState(p.name);
        cleared.push(p.name);
      }
    }
    // Each batch is sent on its own, as each timer would send it, so one whose
    // delivery throws doesn't keep the rest; the first error is thrown after.
    let failed: { err: unknown } | undefined;
    for (const name of [...removed, ...cleared]) {
      try { this.fireDebounce(name); } catch (err) { failed ??= { err }; }
    }
    if (failed) throw failed.err;
    return { removed, cleared };
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (checkedRecently(now, this.lastReloadCheck)) return;
    this.lastReloadCheck = now;

    try {
      // Missing, unchanged or unreadable: the rules in force stay.
      const read = this.readConfigFile({ unlessUnchanged: true });
      // gate.json holds the text in force, so none the start ran is unsaved.
      if (read.state === 'unchanged') this.startUnsaved = null;
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
   * every rule it doesn't change is written back as it was written, problems
   * and fields the gate doesn't read included (rulesForChange). Over a
   * gate.json the gate doesn't use, only a change after which it loads is
   * written, such as one replacing or removing the rule that keeps it out; any
   * other is refused, naming what does, and the file stays as written. When
   * gate.json is absent, or can't be read or isn't JSON, the change edits the
   * text whose rules are in force the same way, or the rules in force where
   * there's none; over a file that can't be read or isn't JSON, after a copy of
   * it is kept beside it (keepUnreadableConfig) and reported to
   * `onUnreadableKept` once the change is written. A policy with the same
   * `name` is replaced IN PLACE when no `position` is given (order preserved);
   * WITH a `position` it is moved there — so re-issuing a rule is also how you
   * reposition it. New policies append
   * by default; `'prepend'` puts one at the very front (ahead of EVERYTHING,
   * including addressed-message wake rules — see the shadow lint), and the
   * anchored forms `{before: name}` / `{after: name}` insert relative to an
   * existing rule, which is almost always the safer way to order a sampler
   * or debounce against a specific catch-all. Fields of the policy the gate
   * reads nowhere, and that aren't a slip of one it does, are left out of
   * what's written, and named to `onIgnoredFields` once the change is; a
   * field it reads at another level is a problem, like a slip.
   *
   * Throws, writing nothing, for an invalid policy, a placement it can't make,
   * a gate.json that can't be read or kept, one with no rule list it could
   * edit without writing over or leaving out what it holds, or one the gate
   * doesn't use that the change doesn't mend; and throws when the write fails,
   * naming any copy kept.
   */
  addPolicy(
    rawPolicy: unknown,
    options?: {
      position?: 'append' | 'prepend' | { before: string } | { after: string };
      onUnreadableKept?: (kept: UnreadableConfigKept) => void;
      onIgnoredFields?: (notes: string[]) => void;
    },
  ): GatePolicy {
    const reading = readRule(rawPolicy, 'A policy');
    if (reading.problems.length > 0 || !reading.policy) throw new Error(refusalOf(reading));
    const policy = reading.policy;
    const ignored = notesOf(reading);
    const edit = this.rulesForChange();
    if ('noList' in edit) throw new Error(noListRefusal(edit.noList));
    const { top, rules, unreadable, remedy } = edit;
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

    const kept = unreadable !== undefined
      ? { keptPath: this.keepUnreadableConfig(unreadable), reason: unreadable.error }
      : undefined;
    this.writeConfigAfterKeep(top, rules, kept, remedy);
    if (kept) options?.onUnreadableKept?.(kept);
    if (ignored.length > 0) {
      // A caller that doesn't take the notes still gets them said, in the log.
      if (options?.onIgnoredFields) options.onIgnoredFields(ignored);
      else console.error(`[gate] ${ignored.join(' ')}`);
    }
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
   * debounce batch is sent once the removal is written and in force, as its
   * timer would have sent it, so buffered events aren't silently dropped
   * (clearStateFor). Freshest on-disk config is re-read first, every other
   * rule is written back as it was written, and a copy of a gate.json that
   * isn't JSON is kept before it's written over (see addPolicy). Throws, writing nothing, for a gate.json with
   * no rule list it could edit, as addPolicy does. Otherwise returns false,
   * writing nothing, if no policy of that name exists, gate.json's own rules
   * included, so one the gate leaves out can be removed by name too. For a
   * name it holds, throws, writing nothing, for a gate.json that can't be read
   * or kept, or one the gate doesn't use that the removal doesn't mend, and
   * when the write fails (naming any copy kept); the rule then stays in force,
   * with its state.
   */
  removePolicy(name: string, options?: { onUnreadableKept?: (kept: UnreadableConfigKept) => void }): boolean {
    const edit = this.rulesForChange();
    if ('noList' in edit) throw new Error(noListRefusal(edit.noList));
    if (!edit.rules.some((rule) => nameOf(rule) === name)) return false;
    const kept = edit.unreadable !== undefined
      ? { keptPath: this.keepUnreadableConfig(edit.unreadable), reason: edit.unreadable.error }
      : undefined;
    // The write clears the rule's state once it has succeeded (writeConfig),
    // so a failed keep or write leaves the rule in force with its state.
    this.writeConfigAfterKeep(edit.top, edit.rules.filter((rule) => nameOf(rule) !== name), kept, edit.remedy);
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
   * Persist gate.json and apply it in memory together: `top`, its own fields,
   * with `rules` as its rule list. Only what loads is written: a change to a
   * gate.json the gate doesn't use, which doesn't mend what keeps it out, throws,
   * naming that and `remedy`, what would bring it into force, and writes
   * nothing. The rules in force are then what the text
   * written reads as, as at a load, so what it still holds that the gate reads
   * past or leaves out stays named; the text is kept as `configText`, so
   * `reloadIfChanged` doesn't parse it again. Once the text is written and its
   * rules are in force, a rule that was in force that it leaves out or gives
   * another behavior loses its state (clearStateFor), last, since a pending
   * batch it sends can't be taken back, and a write that fails leaves the
   * rules in force with their state. Throws if the write fails
   * (disk/permission) — callers surface it as a tool error.
   */
  private writeConfig(top: Record<string, unknown>, rules: unknown[], remedy?: string): void {
    const text = JSON.stringify({ ...top, policies: rules }, null, 2) + '\n';
    const read = readConfig(JSON.parse(text), 'gate.json');
    if ('refused' in read) {
      throw new Error(
        `Nothing was saved: with this change, gate.json wouldn't be used. ${sentence(read.refused)}${remedy ? ` ${remedy}` : ''}`,
      );
    }
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, text);
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
      // A refill interval at or under 0, read from gate.json or the starting
      // rules (readRateLimit), never refills. Divided by, 0 refilled the
      // bucket once and left its clock at NaN.
      if (elapsed > 0 && config.refillIntervalMs > 0) {
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
        const key = this.resolveKey(info.metadata, cfg.keyBy);
        const bucket = this.rateLimitBuckets.get(policy.name)?.get(key);
        if (!bucket) return true; // fresh bucket starts full
        let tokens = bucket.tokens;
        // As applyRateLimit refills: never, for an interval at or under 0.
        if (tokens < cfg.tokens && cfg.refillIntervalMs > 0) {
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
      errors: [this.configErrorShown(), this.startNotice, this.startUnsaved, this.privilegedError]
        .filter((e): e is string => e !== null),
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
