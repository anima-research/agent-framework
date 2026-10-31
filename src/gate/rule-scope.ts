/**
 * What a gate rule decides about: whether its match names an event's server,
 * channel or tags, or takes events without naming any of them (a catch-all).
 * Shared by the gate (gate_status.catchAll) and wake onboarding, which treats
 * a catch-all's let-by as no decision at all (MCPL RFC-001 §6, revision 4).
 */
import type { GatePolicy } from './types.js';

/**
 * Whether a glob names something: a pattern made only of wildcards and
 * separators (`*`, `**`, `*:*`) matches everything, so it names nothing. A
 * namespace glob such as `surface:*` names its namespace.
 */
export const namesSomething = (pattern: unknown): boolean => typeof pattern === 'string' && /[^*?:]/.test(pattern);

/**
 * Whether a rule's match is a decision about the events it takes: it names a
 * source, a channel, or a tag (a tagsAny/tagsAll pattern that names
 * something). Content filters and metadata flags (`metadataTrue`) don't: they
 * take events from every server alike.
 */
export function ruleDecides(policy: GatePolicy): boolean {
  const m = policy.match ?? {};
  if (namesSomething(m.source) || namesSomething(m.channel)) return true;
  return [...(m.tagsAny ?? []), ...(m.tagsAll ?? [])].some(namesSomething);
}

/**
 * The first rule that takes MCPL events without deciding about them, or null.
 * A rule whose scope names no `mcpl:` event type never sees them. With
 * `lettingBy`, only one that lets them by without waking (`defer`/`skip`):
 * the rule that leaves a new server's events undecided.
 */
export function firstCatchAll(policies: readonly GatePolicy[], opts: { lettingBy?: boolean } = {}): string | null {
  for (const p of policies) {
    if (ruleDecides(p)) continue;
    if (opts.lettingBy && p.behavior !== 'defer' && p.behavior !== 'skip') continue;
    const scope = p.match?.scope;
    if (scope && !scope.some((s) => s.startsWith('mcpl:'))) continue;
    return p.name;
  }
  return null;
}
