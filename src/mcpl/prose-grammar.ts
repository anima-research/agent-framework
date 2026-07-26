/**
 * Explicit-prose routing grammar — the SINGLE definition shared by the
 * delivery path (framework.deliverProse*) and the outgoing-stream router
 * (prose-stream-router.ts). Extracted from framework.ts verbatim so the two
 * parsers cannot drift: a streamed chunk and its eventual delivery must agree
 * on what is a prefix, what is a modifier, and what is body.
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
