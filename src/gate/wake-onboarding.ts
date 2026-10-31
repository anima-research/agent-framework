/**
 * Wake onboarding: an MCPL server whose events the agent's wake rules never
 * decided about.
 *
 * A server's events are often skipped by a rule written for something else —
 * a catch-all with no `source` (a Discord-era `discord-ambient`) or the gate's
 * default — so a game that waits on the agent's move, or a message addressed
 * to it, stalls without anyone having chosen that. MCPL RFC-001 §5 lets a
 * server suggest how its tagged events should be treated, and §5.2 forbids a
 * host from applying suggestions it was not told to apply. This module is the
 * missing step between the two: the host notices the first undecided event
 * from a server, offers the agent that server's suggestions once, and records
 * the agent's answer — accepted (all of them or some) or declined — keyed to
 * the server's declared ontology, so it asks again only when the ontology
 * changes.
 *
 * An event is *undecided* when the gate let it go by without waking
 * (`defer`/`skip`) by its default, or by a rule that names neither the event's
 * source nor its channel nor any of its tags. A rule that does — Linn's
 * `touche-quiet`, a channel's debounce — is a decision, and this module leaves
 * it alone. So does the gate's sleep, gate.js, and every rule that wakes later
 * (debounce, judge, a rate limit or sampler).
 *
 * Pure functions here; the framework wires the notice, the wake and the tools.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stableHash } from '../stable-hash.js';
import { firstCatchAll, ruleDecides } from './rule-scope.js';
import type { GateBehavior, GateDecision, GatePolicy } from './types.js';

/**
 * Tags that say an event is addressed to the agent or waiting on it (MCPL
 * RFC-001 `chat:addressed`, RFC-014 `surface:turn`/`surface:alert`; not
 * `surface:invite`, which only suggests). The first undecided event carrying
 * one wakes the agent to decide; any other undecided event leaves its offer
 * for the agent's next turn.
 */
export const ATTENTION_TAGS: readonly string[] = ['chat:addressed', 'surface:turn', 'surface:alert'];

/** Accepted rules are named `suggested:<server>:<n>`: the name is the attribution. */
export const SUGGESTED_RULE_PREFIX = 'suggested:';
export const suggestedRuleName = (server: string, n: number): string => `${SUGGESTED_RULE_PREFIX}${server}:${n}`;
export const isSuggestedRuleOf = (name: string, server: string): boolean => name.startsWith(`${SUGGESTED_RULE_PREFIX}${server}:`);

/** One of a server's suggestions as the host offers it: the server's words and the rule it becomes. */
export interface OfferedRule {
  /** 1-based: the number `wake_accept_suggestions` takes it by. */
  n: number;
  /** The feature set that declared it; empty for the host's own fallback. */
  featureSet: string;
  match: { tagsAny?: string[]; tagsAll?: string[]; tagsNone?: string[] };
  /** The gate behavior the suggestion becomes. */
  behavior: GateBehavior;
  /** The server's own word for it (`immediate`, `{ debounce: 60000 }`, …). */
  said: unknown;
  /** The server's account of what the rule is for and what declining costs. */
  rationale?: string;
  /** The host wrote it: the server suggested nothing it could use. */
  fallback?: boolean;
}

export interface ServerOffer {
  server: string;
  /** What the decision is about: a digest of the server's declared ontologies ('none' without one). */
  digest: string;
  rules: OfferedRule[];
  /** Descriptions the server gave of the tags its rules name. */
  tagDescriptions: Record<string, string>;
  /** Suggestions in the declaration the host could not translate, as given. */
  untranslated: unknown[];
}

type Ontology = {
  tags?: Record<string, unknown>;
  suggestedTreatment?: unknown;
  /** RFC-001 revision 1's name for suggestedTreatment; still accepted. */
  defaultTreatment?: unknown;
};

const DEBOUNCE_MIN_MS = 100;
const DEBOUNCE_MAX_MS = 300_000;
const THROTTLE_DEFAULT_MS = 60_000;

/**
 * A suggested behavior (RFC-001 §6's vocabulary, or the gate's own names) as a
 * gate behavior; null for one with no faithful translation.
 */
export function translateBehavior(said: unknown): GateBehavior | null {
  if (said === 'immediate' || said === 'always') return 'always';
  if (said === 'mute' || said === 'defer' || said === 'skip') return 'defer';
  if (said === 'throttle') return { rate_limit: { tokens: 1, refillIntervalMs: THROTTLE_DEFAULT_MS } };
  if (said && typeof said === 'object' && !Array.isArray(said)) {
    const o = said as Record<string, unknown>;
    if (typeof o.debounce === 'number' && Number.isFinite(o.debounce)) {
      return { debounce: Math.min(DEBOUNCE_MAX_MS, Math.max(DEBOUNCE_MIN_MS, Math.round(o.debounce))) };
    }
    const perMs = (o.throttle as Record<string, unknown> | undefined)?.perMs;
    if (typeof perMs === 'number' && perMs > 0) return { rate_limit: { tokens: 1, refillIntervalMs: Math.round(perMs) } };
    const every = (o.sample as Record<string, unknown> | undefined)?.every;
    if (typeof every === 'number' && Number.isInteger(every) && every > 0) return { passive_sample: { every } };
  }
  return null;
}

const tagList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const tags = v.filter((t): t is string => typeof t === 'string' && t.length > 0);
  return tags.length > 0 ? tags : undefined;
};

/**
 * A server's suggestions from its declared feature sets (null: none declared).
 * Ordered rules first (in each feature set's order), then per-tag suggestions
 * no ordered rule already makes. A server that suggests nothing the host can
 * use gets one host-written rule: wake for its events tagged as addressed to
 * the agent or waiting on it, nothing else.
 */
export function offerFor(server: string, declared: Record<string, { tagOntology?: unknown }> | null): ServerOffer {
  const rules: OfferedRule[] = [];
  const tagDescriptions: Record<string, string> = {};
  const untranslated: unknown[] = [];
  const ontologies: Record<string, unknown> = {};
  const seen = new Set<string>();
  const add = (featureSet: string, match: OfferedRule['match'], said: unknown, rationale?: unknown) => {
    const behavior = translateBehavior(said);
    if (!behavior) { untranslated.push({ featureSet, ...match, behavior: said }); return; }
    const key = stableHash({ match, behavior });
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({
      n: rules.length + 1, featureSet, match, behavior, said,
      ...(typeof rationale === 'string' && rationale.trim() ? { rationale: rationale.trim() } : {}),
    });
  };

  for (const featureSet of Object.keys(declared ?? {}).sort()) {
    const ontology = declared![featureSet]?.tagOntology as Ontology | undefined;
    if (!ontology || typeof ontology !== 'object') continue;
    ontologies[featureSet] = ontology;
    const tags = ontology.tags && typeof ontology.tags === 'object' ? ontology.tags : {};
    const ordered = Array.isArray(ontology.suggestedTreatment) ? ontology.suggestedTreatment
      : Array.isArray(ontology.defaultTreatment) ? ontology.defaultTreatment : [];
    for (const raw of ordered) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const match = {
        ...(tagList(r.tagsAny) ? { tagsAny: tagList(r.tagsAny) } : {}),
        ...(tagList(r.tagsAll) ? { tagsAll: tagList(r.tagsAll) } : {}),
        ...(tagList(r.tagsNone) ? { tagsNone: tagList(r.tagsNone) } : {}),
      };
      // A rule that names no tag would take every event the server sends: that is the agent's call to write, not an offer.
      if (!match.tagsAny && !match.tagsAll) { untranslated.push({ featureSet, ...r }); continue; }
      add(featureSet, match, r.behavior, r.rationale);
    }
    for (const [tag, descriptor] of Object.entries(tags)) {
      const d = descriptor as Record<string, unknown> | null;
      if (!d || typeof d !== 'object') continue;
      if (typeof d.desc === 'string') tagDescriptions[tag] = d.desc;
      if (d.suggestedTreatment !== undefined) add(featureSet, { tagsAny: [tag] }, d.suggestedTreatment, d.rationale);
    }
  }

  if (rules.length === 0) {
    rules.push({
      n: 1, featureSet: '', match: { tagsAny: [...ATTENTION_TAGS] }, behavior: 'always', said: 'immediate', fallback: true,
      rationale: 'This server suggests nothing the host can use. This rule wakes you for its events marked as addressed to you or waiting on you, and leaves the rest as they are.',
    });
  }
  const named = new Set(rules.flatMap((r) => [...(r.match.tagsAny ?? []), ...(r.match.tagsAll ?? [])]));
  for (const tag of Object.keys(tagDescriptions)) if (!named.has(tag)) delete tagDescriptions[tag];
  const digest = Object.keys(ontologies).length > 0 ? stableHash({ server, ontologies }) : 'none';
  return { server, digest, rules, tagDescriptions, untranslated };
}

export { ruleDecides } from './rule-scope.js';

/**
 * Whether the gate let an event go by without anyone having decided to: it did
 * not wake and will not (`defer`/`skip`), by the default or by a rule that
 * doesn't decide about it (ruleDecides). `policy` is the matched rule, as in
 * force; undefined when the decision named none or it can't be found.
 */
export function isUndecided(decision: GateDecision, policy: GatePolicy | undefined): boolean {
  if (decision.trigger) return false;
  if (decision.behavior !== 'skip' && decision.behavior !== 'defer') return false;
  if (decision.policyName === null) return true;
  if (decision.policyName === 'asleep' || decision.policyName === 'gate.js') return false;
  return policy !== undefined && !ruleDecides(policy);
}

export const carriesAttention = (tags: readonly string[] | undefined): boolean => (tags ?? []).some((t) => ATTENTION_TAGS.includes(t));

/**
 * Where an accepted rule goes: ahead of the first rule that would take the
 * server's events without deciding about them (a catch-all), so the rules the
 * agent wrote for this server, or for a channel or tags, keep their place
 * before it. Null: there is none; the rule goes last, ahead of the default.
 * (Accepted rules name their source, so they are never the catch-all.)
 */
export const placementFor = (policies: readonly GatePolicy[]): string | null => firstCatchAll(policies);

/** The gate rules accepting `rules` of `offer` writes. */
export function rulesToWrite(offer: ServerOffer, accepted: readonly OfferedRule[]): GatePolicy[] {
  return accepted.map((r) => ({
    name: suggestedRuleName(offer.server, r.n),
    match: { source: offer.server, ...r.match },
    behavior: r.behavior,
  }));
}

// ---------------------------------------------------------------- decisions

/** The least time between two offers for one server (WakeDecisions.mayOffer). */
export const OFFER_FLOOR_MS = 24 * 60 * 60 * 1000;

export type DecisionState = 'offered' | 'accepted' | 'declined';
export interface DecisionRecord {
  digest: string;
  state: DecisionState;
  /** Accepted: the rule names written. */
  rules?: string[];
  at: string;
}

/**
 * The agent's decisions per server, beside gate.json (`wake-decisions.json`).
 * Written whole, through a temporary file; one that can't be read is set aside
 * and starts empty, so a damaged file costs a repeated offer, never a crash.
 */
export class WakeDecisions {
  private records: Record<string, DecisionRecord> = {};

  constructor(private readonly path: string, private readonly log: (message: string) => void = () => undefined) {
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { servers?: Record<string, DecisionRecord> };
      for (const [server, r] of Object.entries(parsed.servers ?? {})) {
        if (r && typeof r.digest === 'string' && (r.state === 'offered' || r.state === 'accepted' || r.state === 'declined')) this.records[server] = r;
      }
    } catch (error) {
      const aside = `${path}.unreadable-${Date.now()}`;
      try { renameSync(path, aside); } catch { /* leave it */ }
      this.log(`wake decisions: ${path} could not be read (${(error as Error).message}); set aside as ${aside}, starting empty`);
    }
  }

  get(server: string): DecisionRecord | undefined { return this.records[server]; }

  /**
   * Whether an offer for `server` may go out now: never twice for the same
   * digest, answered or not, and not within OFFER_FLOOR_MS of the server's
   * last offer or decision even when its ontology changed — a server can't
   * buy itself a stream of questions by editing what it declares.
   */
  /** Whether an offer for `server` could go out at all, before its digest is known: not within the floor of the last one. */
  mayOfferSoon(server: string, now = Date.now()): boolean {
    const r = this.records[server];
    if (!r) return true;
    const at = Date.parse(r.at);
    return !Number.isFinite(at) || now - at >= OFFER_FLOOR_MS;
  }

  mayOffer(server: string, digest: string, now = Date.now()): boolean {
    const r = this.records[server];
    if (!r) return true;
    if (r.digest === digest) return false;
    const at = Date.parse(r.at);
    return !Number.isFinite(at) || now - at >= OFFER_FLOOR_MS;
  }

  set(server: string, record: Omit<DecisionRecord, 'at'>, now = Date.now()): DecisionRecord {
    const r: DecisionRecord = { ...record, at: new Date(now).toISOString() };
    this.records[server] = r;
    this.write();
    return r;
  }

  all(): Readonly<Record<string, DecisionRecord>> { return this.records; }

  private write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ servers: this.records }, null, 2) + '\n');
      renameSync(tmp, this.path);
    } catch (error) {
      this.log(`wake decisions: could not write ${this.path}: ${(error as Error).message}`);
    }
  }
}
