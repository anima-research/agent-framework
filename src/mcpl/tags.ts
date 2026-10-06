/**
 * Event-tag core closure (SPEC §16.3) and the addressed/ambient resolution.
 *
 * The `chat:*` core implications are NORMATIVE and spec-defined — a host
 * expands them itself and never needs the producer's ontology to do so.
 * Producer `implies` edges are advisory pending explicit acceptance (§16.4)
 * and are NOT consumed here. Producer `suggestedTreatment` MUST NOT be
 * auto-applied (§16.5) — nothing in this module reads it, deliberately.
 *
 * Tags are never authority (§16.6): expansion happens after admission, and
 * nothing downstream may grant, admit, or authorize based on a tag.
 */

/** Normative core closure edges (§16.3). Closed vocabulary — chat:* only. */
const CORE_IMPLIES: Readonly<Record<string, readonly string[]>> = {
  'chat:mention': ['chat:addressed'],
  'chat:reply': ['chat:addressed'],
  'chat:dm': ['chat:addressed', 'chat:private'],
};

/**
 * RFC-001 core tags that mark a message as being ABOUT the conversation
 * rather than part of it: reactions (added or removed), edits and deletions
 * of messages the agent has already seen. These are markers, not turns —
 * they must not clear explicit-send suppression, count as a new
 * conversational round, or retarget the default publish channel. Tags are
 * still never authority (§16.6): this set only ever WITHHOLDS default
 * conversational treatment, it never grants anything.
 */
export const NON_CONVERSATIONAL_TAGS: ReadonlySet<string> = new Set([
  'chat:reaction',
  'chat:reaction-remove',
  'chat:edited',
  'chat:deleted',
]);

/** True when a (possibly untyped) tag list carries a non-conversational marker tag. */
export function hasNonConversationalTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.some((t) => typeof t === 'string' && NON_CONVERSATIONAL_TAGS.has(t));
}

/**
 * Expand a raw tag list over the normative core closure, then resolve the
 * §16.2 mutual exclusion: `chat:addressed` and `chat:ambient` cannot both
 * stand after expansion, and addressed wins — a message that is both
 * specifically-to-you and background noise is specifically-to-you.
 *
 * Pure; input order is preserved for the tags that survive, with implied
 * tags appended in first-cause order. Unknown and producer-namespaced tags
 * pass through untouched.
 */
export function expandCoreTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const t of tags) {
    add(t);
    for (const implied of CORE_IMPLIES[t] ?? []) add(implied);
  }
  if (seen.has('chat:addressed') && seen.has('chat:ambient')) {
    const i = out.indexOf('chat:ambient');
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}
