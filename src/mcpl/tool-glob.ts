/**
 * The portable pattern grammar of MCPL RFC-007 §6.2, used for `tools/observe`
 * filters and (RFC-007 §17 open question 2) for this host's own tool-lifecycle
 * narrowing and tool-class tables:
 *
 *   - `*` matches any sequence of zero or more characters;
 *   - every other character matches itself (no escapes, no other metachars);
 *   - matching is against the whole string, case-sensitive.
 *
 * Patterns are server-supplied, so matching must not backtrack without bound
 * (RFC-007 §10 "Matching cost"). This is the classic two-pointer wildcard
 * match: it remembers only the most recent `*`, so it runs in
 * O(pattern × subject) worst case and never recurses.
 */
export function globMatch(pattern: string, subject: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < subject.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === subject[s]) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = s;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
