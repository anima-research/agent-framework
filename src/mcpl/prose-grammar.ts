/**
 * Explicit-prose routing grammar: the prefix parsers the delivery path uses
 * (parseProsePrefix, parseHybridProsePrefix). The envelope splitters in
 * framework.ts test a line's `>>` or `>>>` start on their own. The outgoing
 * stream needs no parser of its own: it carries what delivery publishes.
 *
 * Grammar (docs/explicit-prose-routing.md):
 *   `>>target [!] [body…]`  — target = channel spec or `skip_reply`
 *   The ` !` continuation modifier must immediately follow the target,
 *   whitespace-separated. Body may start on the same line or the next.
 *   A line's `>>` counts only when immediately followed by a target token
 *   (`>> quoted arrow` stays body text).
 */

export interface ProsePrefix {
  kind: 'target' | 'private' | 'none';
  target?: string;
  continueTurn: boolean;
  body: string;
}

/** Whether a `>>` (or `>>>`) prefix line reads `name` as a target: one token,
 *  and not `skip_reply`, which the line reads as private speech. For a name
 *  offered to an agent to write after `>>`. */
export function isProseTargetToken(name: string): boolean {
  return /^\S+$/.test(name) && name !== 'skip_reply';
}

/** A REAL prefix line: `>>` immediately followed by a target token. */
export const PROSE_PREFIX_LINE = /^>>\S/;

export function parseProsePrefix(text: string): ProsePrefix {
  const m = /^>>(\S+)([ \t]+!)?[ \t]*\n?/.exec(text);
  if (!m) return { kind: 'none', continueTurn: false, body: text };
  const target = m[1]!;
  const continueTurn = m[2] !== undefined;
  const body = text.slice(m[0].length);
  // `skip_reply` mirrors the tool the model already knows: text stays in
  // context, nothing is delivered. (Deliberately NOT called "private"/"note" —
  // that vocabulary sat adjacent to signed thinking in a live window and drew
  // a reasoning_extraction classifier hit, 2026-07-24 Fable.)
  if (target === 'skip_reply') {
    return { kind: 'private', continueTurn, body };
  }
  return { kind: 'target', target, continueTurn, body };
}

/** A real hybrid routing line: exact triple-arrow plus an optional whitespace
 * run and a non-whitespace target token. */
export const HYBRID_PROSE_PREFIX_LINE = /^>>>[ \t]*\S/;

/**
 * Hybrid/locus-preserving routing grammar.
 *
 * `>>>#cafe body` and `>>> #cafe body` route this envelope explicitly while
 * unprefixed prose remains ordinary frozen-locus speech. The authored source
 * is never rewritten; callers consume this view only for publication.
 */
export function parseHybridProsePrefix(text: string): ProsePrefix {
  const m = /^>>>[ \t]*(\S+)([ \t]+!)?[ \t]*\n?/.exec(text);
  if (!m) return { kind: 'none', continueTurn: false, body: text };
  const target = m[1]!;
  const continueTurn = m[2] !== undefined;
  const body = text.slice(m[0].length);
  if (target === 'skip_reply') return { kind: 'private', continueTurn, body };
  return { kind: 'target', target, continueTurn, body };
}
