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
