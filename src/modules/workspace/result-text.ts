import type { ToolResult } from '../../types/events.js';

/**
 * The text a model reads of read's, grep's, edit's and edit_many's answers:
 * a header of the answer's own fields, one `key: value` to a line in the
 * fields' order, then its sections, each a `--- label ---` line and the lines
 * under it, an empty one left out. The answer's fields themselves reach a
 * script as its structuredContent (ToolResult.structured), and a page or a
 * receipt is held to the call's result limit as this text measures it.
 */

/** The characters Unicode says end a line (UAX #14's mandatory breaks): LF, VT, FF, CR, NEL, U+2028 and U+2029. */
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * A value as a header line, a section's label or a listed line writes it: as
 * it is, or, where it holds a line break or starts with a quote, as a JSON
 * string. A path can hold a line break, and so can a note naming it or a line
 * of a file grep matched; written as it is, it would start a line that reads
 * as one of the answer's own. A value written as it is never starts with a
 * quote, so one that does is always the quoted form, which gives back exactly
 * what the value holds: without that, a value that is itself a JSON string,
 * such as a line of a file reading `"a\nb"`, would read as the quoted form of
 * another. JSON leaves NEL, U+2028 and U+2029 as they are, so they're escaped
 * too.
 */
export function shownValue(value: string | number | boolean | null): string {
  if (typeof value !== 'string') return String(value);
  if (!value.startsWith('"') && !LINE_BREAK.test(value)) return value;
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export type DiskState = 'done' | 'waits for materialize' | 'waits for materialize with applyDeletions' | 'in conflict with disk';

/** A header line: a field's key and its value as shownValue writes it. */
export const fieldLine = (key: string, value: string | number | boolean | null): string => `${key}: ${shownValue(value)}`;

/** A section's text, its label and then its lines; an empty section is no text. */
export const sectionText = (label: string, body: string): string => (body === '' ? '' : `--- ${label} ---\n${body}`);

/** The answer's text: its header lines and then its sections, each on lines of its own. */
export const answerText = (header: string[], sections: string[] = []): string =>
  [...header, ...sections.filter((section) => section !== '')].join('\n');

/** How much a section with any lines adds to its answer's text before them: the line feed before its label, and the label's line. */
export const sectionLead = (label: string): number => `\n--- ${label} ---\n`.length;

/** A success whose text is what the model reads and whose fields reach a script as its structuredContent. */
export const textAnswer = (text: string, structured: Record<string, unknown>): ToolResult =>
  ({ success: true, data: [{ type: 'text', text }], structured });

/** A grep result: the matches of one version of a file. */
export interface GrepResult {
  file: string;
  state?: string;
  version: string;
  lineEndings?: string;
  matches: Array<{ line: number; text: string; context?: string[] }>;
}

/** What grep found, as its structuredContent holds it. */
export interface GrepAnswer {
  pattern: string;
  results: GrepResult[];
  totalMatches: number;
  note?: string;
  skipped?: Array<{ file: string; reason: string; size?: number; mimeType?: string }>;
  incomplete?: Array<{ path: string; reason: string }>;
}

/**
 * grep's text: its pattern, match count and note, then a section for each
 * version of a file it matched, labelled with the file, the version, the
 * file's state where grep gives one and its line ends where it has them, then
 * what it skipped and where its search was incomplete. As grep writes them, a
 * match's line reads `N:text`, and where the call asked for context, each
 * line around it reads `N-text`: matches whose context meets or overlaps are
 * one run of lines, each line once, and `--` stands between runs with lines
 * left out between them. Each match's context starts `contextBefore` lines
 * before it, or at the file's first line. A line's text is written through
 * shownValue, since more of the answer follows it.
 */
export function grepText(answer: GrepAnswer, contextBefore: number): string {
  const header = [fieldLine('pattern', answer.pattern), fieldLine('totalMatches', answer.totalMatches)];
  if (answer.note !== undefined) header.push(fieldLine('note', answer.note));
  const sections = answer.results.map((result) => {
    const label = `${shownValue(result.file)}: ${result.version}`
      + (result.state !== undefined ? ` (${result.state})` : '')
      + (result.lineEndings !== undefined ? `; lineEndings: ${result.lineEndings}` : '');
    const lines: string[] = [];
    const matched = new Set(result.matches.map((match) => match.line));
    // The last line written: matches come in line order, so a window that
    // meets or overlaps the run before it goes on from there.
    let last = 0;
    for (const match of result.matches) {
      if (match.context === undefined) {
        lines.push(`${String(match.line).padStart(6)}:${shownValue(match.text)}`);
        continue;
      }
      const first = Math.max(1, match.line - contextBefore);
      match.context.forEach((text, k) => {
        const n = first + k;
        if (n <= last) return;
        if (last > 0 && n > last + 1) lines.push('--');
        lines.push(`${String(n).padStart(6)}${matched.has(n) ? ':' : '-'}${shownValue(text)}`);
        last = n;
      });
    }
    return sectionText(label, lines.join('\n'));
  });
  if (answer.skipped !== undefined) {
    sections.push(sectionText('skipped', answer.skipped.map((skip) => {
      const facts = [...(skip.size !== undefined ? [`${skip.size} bytes`] : []), ...(skip.mimeType !== undefined ? [skip.mimeType] : [])];
      return `${shownValue(skip.file)}: ${shownValue(skip.reason)}${facts.length ? ` (${facts.join(', ')})` : ''}`;
    }).join('\n')));
  }
  if (answer.incomplete !== undefined) {
    sections.push(sectionText('incomplete', answer.incomplete.map((gap) => `${shownValue(gap.path)}: ${shownValue(gap.reason)}`).join('\n')));
  }
  return answerText(header, sections);
}
