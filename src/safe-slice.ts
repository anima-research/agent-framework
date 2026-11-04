/**
 * Slice a string without splitting surrogate pairs.
 *
 * Regular String.prototype.slice can cut in the middle of a surrogate pair,
 * producing invalid UTF-16. Here no half of a pair faces a cut: a start on a
 * low surrogate moves forward past it, and an end just after a high surrogate
 * moves back before it, whether or not the other half is there. A start of 0
 * and an end at or past the length cut nothing, so the string's own first and
 * last units stay as they are.
 */
export function safeSlice(str: string, start: number, end: number): string {
  // A low surrogate where the start cuts is a pair's second half, or a lone half: either way, skip it
  const first = str.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start += 1;

  if (end >= str.length) return str.slice(start);

  // If we're about to cut between a high and low surrogate, back up one char
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    // end-1 is a high surrogate — don't split the pair
    return str.slice(start, end - 1);
  }

  return str.slice(start, end);
}
