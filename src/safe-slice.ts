/**
 * Slice a string without splitting surrogate pairs.
 *
 * Regular String.prototype.slice can cut in the middle of a surrogate pair,
 * producing invalid UTF-16. This function adjusts the end index to avoid that.
 */
export function safeSlice(str: string, start: number, end: number): string {
  if (end >= str.length) return str.slice(start);

  // If we're about to cut between a high and low surrogate, back up one char
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    // end-1 is a high surrogate — don't split the pair
    return str.slice(start, end - 1);
  }

  return str.slice(start, end);
}
