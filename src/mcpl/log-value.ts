/**
 * A value a connected server chose, as one field of a host log line.
 *
 * The rejection lines (`[channel-incoming-rejected]`, `[push-event-rejected]`)
 * and the other host lines that name a server's own identifiers are read a
 * line at a time, by eye and with grep. Printed raw, an identifier carrying a
 * line break prints a second line that reads as another host record, about
 * another server; one carrying a space can pose as another field of the same
 * line; and one carrying `=` can hold a lookalike field (`reason=…`) that a
 * search for that field finds before the real one.
 *
 * A plain token (visible characters only: no space, quote, backslash or `=`)
 * prints as it is, so ordinary ids read and grep as they always have.
 * Anything else prints as a JSON string with every `=` and every invisible
 * character escaped: controls, format and bidi characters, line and paragraph
 * separators, every space (the plain one included), default-ignorable
 * characters (Hangul fillers, the combining grapheme joiner, variation
 * selectors) and the blank Braille pattern. So it stays one field on one line,
 * a reader that splits on whitespace keeps it whole, no field holds a raw
 * `=` (so every `=` before a line's free-text tail, `logDetail`, belongs to
 * a real field), and `JSON.parse` of a quoted value that isn't cut gives
 * back exactly what was sent. Escaping rather than stripping keeps two
 * identifiers that differ in invisible characters within the units a line
 * prints from printing alike; canonically equivalent or lookalike
 * identifiers still can.
 *
 * A value longer than 256 UTF-16 units is cut, so one value can't make a line
 * long: it prints quoted, as its first 256 units (255 when the 256th is a
 * high surrogate, so a pair is never split), each at most six characters once
 * escaped, followed by `…(N)`, N being its full length. `JSON.parse` of the
 * quoted part gives back those first units. A cut value always opens with a
 * quote, and its marker follows the closing quote. A plain token never holds
 * a quote, and a quoted value that isn't cut ends at its closing quote, so
 * only a value that was cut prints as one.
 *
 * A value that isn't a string prints as its JSON text, quoted as any text is
 * that isn't a plain token: the number 5 prints as `5`, and `{"toString":1}`
 * as `"{\"toString\":1}"`. So the number 5 and the string "5" print alike, as
 * they name the same message. A number JSON writes as `null` (NaN, Infinity)
 * prints as `String()` of it. Converting a value never throws: one JSON can't
 * write prints as `String()` of it, or else as its object tag, and one none
 * of those can read (a revoked Proxy) as `[unprintable]`.
 */
export function logValue(value: unknown): string {
  return printed(textOf(value), FIELD);
}

/**
 * The host's own message, as the free text that ends a log line after its
 * fields: `reason=coalesce-invalid field=payload.content: "content must be an
 * array"`. It prints as `logValue` prints a field, cut the same way, except
 * that a plain space and `=` stay raw, for reading. That is safe because the
 * text is the host's (an error the host raised), not an id a sender chose,
 * and every real field of the line comes before it.
 */
export function logDetail(value: unknown): string {
  return printed(textOf(value), DETAIL);
}

/** How a form prints: the text that stands as it is, and what it escapes. */
interface Form {
  plain: RegExp;
  escaped: RegExp;
}

const FIELD: Form = {
  plain: /^[^"\\=\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]+$/u,
  escaped: /[=\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu,
};

const DETAIL: Form = {
  plain: /^[^"\\\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]+$/u,
  escaped: /(?! )[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu,
};

/** The most of a value's text a line prints, in UTF-16 units. */
const MAX_PRINTED = 256;

function printed(text: string, form: Form): string {
  if (text.length <= MAX_PRINTED) return form.plain.test(text) ? text : quoted(text, form);
  let end = MAX_PRINTED;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${quoted(text.slice(0, end), form)}…(${text.length})`;
}

function quoted(text: string, form: Form): string {
  // JSON escapes C0 controls, quotes and backslashes and leaves the rest of
  // the escaped set raw: escape those here, per UTF-16 unit, as JSON does.
  return JSON.stringify(text).replace(form.escaped, escapeUnits);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  // JSON writes a non-finite number as null, which reads as a missing value.
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  const readers = [
    () => JSON.stringify(value) ?? String(value),
    () => String(value),
    () => Object.prototype.toString.call(value),
  ];
  for (const read of readers) {
    try {
      return read();
    } catch {
      // the next reader
    }
  }
  return '[unprintable]';
}

function escapeUnits(chars: string): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) out += `\\u${chars.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}
