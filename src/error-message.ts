/**
 * What a thrown value says: an Error's message, or any other value as a
 * string, without the "Error: " that `String(error)` puts in front.
 *
 * It never throws. Every inspection and coercion of the value is inside the
 * try, so a revoked Proxy (whose instanceof throws), a hostile getter, an
 * Error whose message isn't a string, or a value with no string form reads
 * as text or as unreadable. It doesn't bound the text: a message the module
 * wrote for the agent often ends with its remedy, which a bound would cut. A
 * caller that writes it to a log or a server's answer bounds it there, with
 * boundedErrorMessage.
 */
export function errorMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return '(a value that could not be read)';
  }
}

/**
 * The most of a thrown value's text that reaches a log line, a server's error
 * answer or an agent's frame around an error nobody expected.
 */
export const THROWN_TEXT_LIMIT = 500;

/**
 * errorMessage, cut to `limit` characters with the whole length said, for a
 * value whose text nobody wrote for its reader: a handler's throw sent on as
 * an answer, or an error a module didn't expect quoted inside its own frame,
 * since a provider or handler error can carry a whole request body.
 *
 * Characters are code points, so a cut never leaves half of a surrogate pair
 * at the end. The text is walked rather than spread into an array, which for
 * a whole request body would hold every code point at once.
 */
export function boundedErrorMessage(error: unknown, limit = THROWN_TEXT_LIMIT): string {
  const text = errorMessage(error);
  // A code point takes one or two UTF-16 units, so text this short is within the limit.
  if (text.length <= limit) return text;
  let points = 0;
  let cut = 0;
  for (const point of text) {
    if (points < limit) cut += point.length;
    points++;
  }
  return points <= limit ? text : `${text.slice(0, cut)}… (${points} characters)`;
}
