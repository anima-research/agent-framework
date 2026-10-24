import { isUtf8 } from 'node:buffer';

/**
 * A stored file's text as read shows it and grep searches it, and lines
 * numbered the way `cat -n` numbers them, with a long one cut. Read, grep and
 * edit's answers use them.
 */

/** Whether the bytes open with a UTF-8 byte order mark. */
export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export interface FileText {
  /** The bytes decoded as UTF-8, as character paging reads them: a BOM and every CR kept. */
  raw: string;
  /**
   * Its lines, as read shows them and grep searches them: without the BOM, a
   * CR before a line feed dropped, and a final line end ending the last line
   * rather than starting an empty one. So "a\r\nb\r\n" is two lines, and an
   * empty text has none. A line whose own text ends in a CR keeps its line
   * end's CR too, as stored: an edit reads a CR before a line feed in its old
   * text as part of the line end, so text copied from "a\r" and the next line
   * would lose the CR that is the line's own.
   */
  lines: string[];
  /** Where each line starts in `raw`. */
  starts: number[];
  bom: boolean;
  /** How many line ends were CRLF, and how many a bare LF. */
  crlfEnds: number;
  lfEnds: number;
  /** How many lines with a CRLF end keep its CR, since their own text ends in a CR. */
  crKept: number;
  /** Whether the bytes are valid UTF-8; where they aren't, `raw` holds U+FFFD. */
  utf8: boolean;
}

export function fileText(bytes: Buffer): FileText {
  const raw = bytes.toString('utf-8');
  const bom = hasBom(bytes);
  const lines: string[] = [];
  const starts: number[] = [];
  let crlfEnds = 0;
  let lfEnds = 0;
  let crKept = 0;
  // A BOM decodes to the single code unit U+FEFF.
  for (let at = bom ? 1 : 0; at < raw.length;) {
    const lf = raw.indexOf('\n', at);
    starts.push(at);
    if (lf === -1) {
      lines.push(raw.slice(at));
      break;
    }
    const crlf = lf > at && raw.charCodeAt(lf - 1) === 13;
    if (crlf) crlfEnds++; else lfEnds++;
    const keepsCr = crlf && lf - 1 > at && raw.charCodeAt(lf - 2) === 13;
    if (keepsCr) crKept++;
    lines.push(raw.slice(at, crlf && !keepsCr ? lf - 1 : lf));
    at = lf + 1;
  }
  return { raw, lines, starts, bom, crlfEnds, lfEnds, crKept, utf8: isUtf8(bytes) };
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
 * it holds past the cut, or, where `readOn` is given, how to read them.
 */
export function numberedLine(line: string, n: number, maxChars = MAX_LINE_CHARS, readOn?: (cut: number) => string): string {
  const number = String(n).padStart(6);
  if (line.length <= maxChars) return `${number}\t${line}`;
  const cut = safeCut(line, maxChars);
  return `${number}\t${line.slice(0, cut)} [… ${readOn ? readOn(cut) : `${line.length - cut} more chars`}]`;
}

/** Lines numbered from `start`, each as numberedLine shows it. */
export function numbered(lines: string[], start: number, maxChars = MAX_LINE_CHARS): string {
  return lines.map((line, i) => numberedLine(line, start + i, maxChars)).join('\n');
}
