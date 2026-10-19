/**
 * Lines numbered the way `cat -n` numbers them, with a long one cut, and a
 * string's length as JSON, which a budget for a stored result counts. edit's
 * answers use them.
 */

/** Whether the bytes open with a UTF-8 byte order mark. */
export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** How long a line read shows before it cuts the line. */
export const MAX_LINE_CHARS = 2000;

/**
 * Where to cut a string at or just before `at` without splitting a surrogate
 * pair: a lone surrogate isn't text, and a model provider can refuse a
 * request that carries one.
 */
export function safeCut(value: string, at: number): number {
  if (at <= 0 || at >= value.length) return Math.max(0, Math.min(at, value.length));
  const before = value.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at;
}

/**
 * One line numbered the way `cat -n` numbers it: a six-wide number, a tab and
 * the line. A line longer than `maxChars` is cut, saying how many characters
 * it holds past the cut, and `readOn` adds how to read them.
 */
export function numberedLine(line: string, n: number, maxChars = MAX_LINE_CHARS, readOn?: (cut: number) => string): string {
  const number = String(n).padStart(6);
  if (line.length <= maxChars) return `${number}\t${line}`;
  const cut = safeCut(line, maxChars);
  return `${number}\t${line.slice(0, cut)} [… ${line.length - cut} more chars${readOn ? `; ${readOn(cut)}` : ''}]`;
}

/** Lines numbered from `start`, each as numberedLine shows it. */
export function numbered(lines: string[], start: number, maxChars = MAX_LINE_CHARS): string {
  return lines.map((line, i) => numberedLine(line, start + i, maxChars)).join('\n');
}

/**
 * How many characters a string takes inside JSON's quotes, as JSON.stringify
 * writes it: a quote, a backslash or a control character is escaped, and so
 * is a lone surrogate.
 */
export function jsonLength(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) length += jsonCharLength(value, i);
  return length;
}

/** The JSON length of the code unit at `i`, as jsonLength counts it. */
export function jsonCharLength(value: string, i: number): number {
  const c = value.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return 2;
  if (c < 0x20) return c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = value.charCodeAt(i + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 1 : 6;
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    const before = i > 0 ? value.charCodeAt(i - 1) : 0;
    return before >= 0xd800 && before <= 0xdbff ? 1 : 6;
  }
  return 1;
}
