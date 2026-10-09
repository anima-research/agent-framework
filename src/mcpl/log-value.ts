/**
 * A value a connected server chose, as one field of a host log line.
 *
 * The rejection lines (`[channel-incoming-rejected]`, `[push-event-rejected]`)
 * name the sender's own identifiers, and the host log is read a line at a
 * time. Printed raw, an identifier carrying a line break prints a second line
 * that reads as another host record, about another server; one carrying a
 * space can pose as another field of the same line.
 *
 * A plain token (visible characters only: no space, quote or backslash)
 * prints as it is, so ordinary ids read and grep as they always have.
 * Anything else prints as a JSON string with every invisible character
 * escaped (controls, format and bidi characters, line and paragraph
 * separators, and every space but the plain one), so it stays one field on
 * one line, and `JSON.parse` of it gives back exactly what was sent. Escaping
 * rather than stripping keeps two different identifiers from printing alike.
 */
export function logValue(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  if (PLAIN_TOKEN.test(text)) return text;
  // JSON escapes C0 controls, quotes and backslashes and leaves the rest of
  // the invisible set raw: escape those here, per UTF-16 unit, as JSON does.
  return JSON.stringify(text).replace(UNSEEN, (chars) => (chars === ' ' ? chars : escapeUnits(chars)));
}

const PLAIN_TOKEN = /^[^"\\\p{C}\p{Z}]+$/u;
const UNSEEN = /[\p{C}\p{Z}]/gu;

function escapeUnits(chars: string): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) out += `\\u${chars.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}
