/**
 * Text the framework didn't write (what a participant or a server supplied),
 * put beside structure of the framework's own: the reply judge's document,
 * and notices the framework writes. A value that can end its line can start
 * a line that reads as the framework's own.
 */

import { CONTEXT_MANAGER_TAGS, MEMBRANE_TAGS, NOTICE_TAG } from './notice-tags.js';

/** Every form of line break a reader might take for one: CR LF, CR, LF,
 *  vertical tab, form feed, NEL, and the Unicode line and paragraph separators. */
const LINE_BREAK = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;

/** Text with each line break, in whatever form, as `\n`. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(LINE_BREAK, '\n');
}

/** A value kept to one line: each run of line breaks, in whatever form, as one
 *  space, so it can't end the line it's put in or start one of its own. */
export function oneLine(text: string): string {
  return normalizeLineBreaks(text).replace(/\n+/g, ' ');
}

const INVISIBLE = '\\p{Cf}\\p{Default_Ignorable_Code_Point}';
const SKIPPED = `[\\s\\p{Cc}${INVISIBLE}]`;
const tagWord = (word: string): string =>
  [...word].map((c) => (/[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c)).join(`${SKIPPED}*`);
const NOTICE_OPENING = new RegExp(
  `\\[(?=${SKIPPED}*(?:${[...Object.values(NOTICE_TAG), ...CONTEXT_MANAGER_TAGS, ...MEMBRANE_TAGS].map((tag) => tag.split(' ').map(tagWord).join(`${SKIPPED}+`)).join('|')})(?![\\p{L}\\p{N}]))`,
  'giu',
);

/**
 * Texts read as one string, joined by line breaks, with a backslash put
 * before the bracket of each opening of a listed tag (NOTICE_TAG,
 * CONTEXT_MANAGER_TAGS, MEMBRANE_TAGS) that hasn't one before it in its own
 * text. A text `marks` says false of is read and never changed.
 *
 * Every opening, not only one that starts a line: membrane's XML formatter
 * writes `participant: ` before each message, so the framework's own
 * openings stand mid-line there too. It joins a message's text blocks with
 * line breaks and sets its images apart from that text, while the native
 * formatter sends each block on its own, so an opening split across a
 * message's text blocks is one either way. In any case, by Unicode's case folding, and
 * through whitespace, control and invisible characters anywhere inside the
 * bracket, which a model reads past.
 */
export function markedTexts(texts: readonly string[], marks: readonly boolean[] = []): string[] {
  const starts: number[] = [];
  let at = 0;
  for (const text of texts) {
    starts.push(at);
    at += text.length + 1;
  }
  const offsets: number[][] = texts.map(() => []);
  for (const match of texts.join('\n').matchAll(NOTICE_OPENING)) {
    let holder = texts.length - 1;
    while (starts[holder]! > match.index) holder--;
    const offset = match.index - starts[holder]!;
    if (marks[holder] !== false && texts[holder]![offset - 1] !== '\\') offsets[holder]!.push(offset);
  }
  return texts.map((text, i) => withMarks(text, offsets[i]!));
}

function withMarks(text: string, offsets: readonly number[]): string {
  let marked = '';
  let from = 0;
  for (const offset of offsets) {
    marked += `${text.slice(from, offset)}\\`;
    from = offset;
  }
  return marked + text.slice(from);
}

function closedWithin(text: string, at: number): boolean {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return true;
  }
  return false;
}

function unmarkedOpenings(text: string): number[] {
  return [...text.matchAll(NOTICE_OPENING)].map((match) => match.index).filter((at) => text[at - 1] !== '\\');
}

export function markedText(text: string): string {
  return markedTexts([text])[0]!;
}

export function markNoticeOpenings<T extends object>(blocks: readonly T[], marks: (index: number) => boolean = () => true): T[] {
  const at: number[] = [];
  blocks.forEach((block, index) => {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') at.push(index);
  });
  const textOf = (index: number): string => (blocks[index] as unknown as { text: string }).text;
  const marked = markedTexts(at.map(textOf), at.map(marks));
  const out = [...blocks];
  at.forEach((index, i) => {
    if (marked[i] !== textOf(index)) out[index] = { ...blocks[index]!, text: marked[i] };
  });
  return out;
}

export function suppliedValue(value: unknown): string {
  return markedText(oneLine(String(value)));
}

export function cutToFit(text: string, length: number): string {
  let end = Math.max(0, Math.floor(length));
  if (end >= text.length) return text;
  for (;;) {
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    else if (text[end - 1] === '\\' && text[end] === '[') end--;
    else {
      const cut = text.slice(0, end);
      const open = unmarkedOpenings(cut).find((at) => !closedWithin(cut, at));
      if (open === undefined) return cut;
      end = open;
    }
  }
}

export function showsAsItself(value: string): boolean {
  return value !== '' && suppliedValue(value) === value && value.isWellFormed() && !EDGE_OR_QUOTE.test(value);
}

const EDGE_OR_QUOTE = /^\s|\s$|["\\]/;

export function quotedValue(value: unknown, space?: number): string {
  return (JSON.stringify(value, null, space) ?? 'null').replace(/"(?:[^"\\]|\\.)*"/g, (literal) => quotedString(JSON.parse(literal)));
}

function quotedString(text: string): string {
  let quoted = '';
  let from = 0;
  for (const match of text.matchAll(NOTICE_OPENING)) {
    quoted += `${jsonText(text.slice(from, match.index))}\\u005b`;
    from = match.index + 1;
  }
  return `"${quoted}${jsonText(text.slice(from))}"`;
}

// JSON.stringify leaves NEL, U+2028 and U+2029 as they are.
const jsonText = (text: string): string =>
  JSON.stringify(text).slice(1, -1).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function nameToTypeBack(name: string): string {
  return showsAsItself(name) ? name : quotedValue(name);
}
