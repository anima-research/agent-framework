/**
 * Exact-text matching for edit and edit_many: where each edit's old text
 * occurs in a file, what stops an edit applying, and the file's new bytes once
 * every edit applies. Every edit is matched in the text as read, never in
 * another edit's result, so the order of the edits doesn't matter and no edit
 * can take away the text another needs. No I/O: the caller reads, stores and
 * words the refusals.
 *
 * Ported from anima-research/hands-mcp's src/match.ts, where it serves the
 * Edit and EditMany tools.
 */

import { MAX_LINE_CHARS, hasBom, numbered, safeCut } from './text.js';

/** One edit as the planner takes it. */
export interface EditSpec {
  /** Its place in the call's list, from 0. */
  index: number;
  /** The old and new text, with every CRLF made LF. */
  oldText: string;
  newText: string;
  /** How many times oldText must occur: a count, or 'all' (edit's replaceAll) for at least once. */
  expected: number | 'all';
}

/** A file's text as matching sees it. */
export interface FileText {
  /** The text as stored, after a UTF-8 BOM. */
  raw: string;
  /** The same text with every CRLF made LF, the text edits are matched in. */
  value: string;
  /** Ascending, the index in `value` of each LF that followed a CR. */
  crs: number[];
  /** How many line ends the text has in all. */
  lfs: number;
  bom: boolean;
}

/**
 * The file's text, or undefined when it isn't valid UTF-8: rewriting such a
 * file would change bytes outside the edits.
 */
export function decodeForEdit(bytes: Buffer): FileText | undefined {
  const bom = hasBom(bytes);
  let raw: string;
  try {
    // fatal: a byte sequence that isn't UTF-8 would come back as U+FFFD and be
    // written over the file.
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
  return { raw, bom, ...lineEnds(raw) };
}

/**
 * A file's text with every CRLF made LF, and where the CRs were: `crs` holds,
 * ascending, the index in `value` of each LF that followed a CR. Matching works
 * on `value`; rawIndex maps an index of it back to the file's own text, so a
 * replacement touches only the bytes it replaces.
 */
function lineEnds(raw: string): { value: string; crs: number[]; lfs: number } {
  let lfs = 0;
  for (let at = raw.indexOf('\n'); at !== -1; at = raw.indexOf('\n', at + 1)) lfs++;
  if (!raw.includes('\r\n')) return { value: raw, crs: [], lfs };
  const parts: string[] = [];
  const crs: number[] = [];
  let length = 0;
  let from = 0;
  for (let at = raw.indexOf('\r\n'); at !== -1; at = raw.indexOf('\r\n', at + 2)) {
    parts.push(raw.slice(from, at));
    length += at - from;
    crs.push(length);
    from = at + 1; // keep the LF
  }
  parts.push(raw.slice(from));
  return { value: parts.join(''), crs, lfs };
}

/**
 * Straight and curly quotes compared as equal, for a second-chance match on
 * prose edits. Each quote is one code unit either way, so offsets carry over.
 */
function normalizeQuotes(value: string): string {
  return value.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/** What a reading of an old text leaves out of it, as matching leaves it out of the file's text. */
export type Leaves = 'nothing' | 'cr' | 'bom' | 'both';

/**
 * The readings of an edit other than as given, where its old text carries
 * what matching leaves out of a file's text: the BOM, which decodeForEdit
 * takes off before the first line, at its start, or a line's CR, which
 * matching reads as part of the line end, at its end. A character page shows
 * both, and a line whose own text ends in a CR shows its end's CR too
 * (shownLine). Each reading leaves out the CR, the BOM, or both, its new text
 * read the same way, so a replacement keeps the file's one BOM and its CRLF
 * line end, and may match only where what it leaves out is the file's: at the
 * text's start for the BOM, and before a CRLF line end for the CR. None where
 * the old text carries neither where the file has them. A reading that
 * leaves nothing, of an old text that is the BOM or the CR alone, is one too:
 * planFile finds it where what it leaves out is the file's.
 */
function readingsOf(spec: EditSpec, file: FileText, crAt: (lf: number) => boolean): Array<{ spec: EditSpec; accept: (at: number) => boolean; leaves: Leaves }> {
  const leading = file.bom && spec.oldText.startsWith('\uFEFF');
  const trailing = file.crs.length > 0 && spec.oldText.endsWith('\r');
  const read = (bom: boolean, cr: boolean, leaves: Leaves) => {
    const oldText = spec.oldText.slice(bom ? 1 : 0, cr ? -1 : undefined);
    let newText = spec.newText;
    if (bom && newText.startsWith('\uFEFF')) newText = newText.slice(1);
    if (cr && newText.endsWith('\r')) newText = newText.slice(0, -1);
    return [{
      spec: { ...spec, oldText, newText },
      // crs holds only LFs that followed a CR, so one there is a CRLF line end.
      accept: (at: number) => (!bom || at === 0) && (!cr || crAt(at + oldText.length)),
      leaves,
    }];
  };
  return [
    ...(trailing ? read(false, true, 'cr') : []),
    ...(leading ? read(true, false, 'bom') : []),
    ...(leading && trailing ? read(true, true, 'both') : []),
  ];
}

/** Where an old text occurs in a file: what scan finds. */
interface Found {
  /** The first `keep` positions it starts at. */
  starts: number[];
  /** How many positions it starts at, or with `atLeast`, how many the scan found before it stopped. */
  count: number;
  /** Whether one occurrence starts before the one before it ends. */
  overlapping: boolean;
  atLeast: boolean;
  /** Whether it stopped because the call's count budget ran out, so `count` is a floor for that reason. */
  spent: boolean;
}

/**
 * What one call may count of occurrences no answer needs, all of its edits
 * together: those past what an edit asks for and the one more that shows it
 * finds more, which only make a refusal's count exact. applyEdits sizes it
 * before it plans, to the larger of the mount's limit and the largest file
 * the call names, in bytes, which no file's occurrences of a nonempty text
 * pass, as a file has no more code units than bytes; so it's the same
 * whatever order the files are planned in, and an edit's count in a call of
 * its own is exact, even in a file stored before its mount's limit was
 * lowered. planFile raises it to any text longer than it, for a caller that
 * sizes it smaller. Past it, a count is a floor. Without it, each of many
 * edits of a text with millions of occurrences counted them all, at a cost
 * of the edits times the occurrences. COUNT_MAX, the default limit's, serves
 * a caller with none.
 */
export interface CountBudget {
  left: number;
  /** What it holds in all: what it was sized to, or the longest text planned with it, if that's more. */
  size: number;
}
export const COUNT_MAX = 5 * 1024 * 1024;
export const countBudget = (maxBytes = COUNT_MAX): CountBudget => ({ left: maxBytes, size: maxBytes });

/**
 * Where needle starts in haystack: every position, overlapping ones included,
 * so "aa" starts twice in "aaa". The first `keep` positions are kept; `count`
 * is all of them, unless occurrences overlap. Those can't each be replaced, so
 * the edit is refused whatever their count, and the scan stops once it has
 * found one more than the SHOWN_MATCHES a refusal shows, so a count it stopped
 * at is more than those shown. Otherwise a needle that overlaps itself,
 * such as a run of spaces, would be compared in full at every position of a
 * long run of the same, at a cost of the run's length times the needle's.
 * With `accept`, only the positions it accepts are occurrences, and the stop
 * can't apply to the positions it passes over, so those are found in one
 * pass over the haystack (everyOccurrence). The first `free` occurrences are
 * counted freely; each past them takes one from `budget`, and the scan stops
 * once it's spent, its count then a floor (`spent`).
 */
function scan(haystack: string, needle: string, keep: number, accept?: (at: number) => boolean, free = Infinity, budget?: CountBudget): Found {
  const starts: number[] = [];
  let count = 0;
  let overlapping = false;
  let spent = false;
  // indexOf finds the empty string at every position, never -1: callers refuse
  // an empty old text, and this keeps any other caller from looping.
  if (!needle) return { starts, count, overlapping, atLeast: false, spent };
  let previous = -Infinity;
  // Takes the occurrence at `at`, and says whether to look for the next.
  const take = (at: number): boolean => {
    if (accept && !accept(at)) return true;
    if (at < previous + needle.length) overlapping = true;
    if (count < keep) starts.push(at);
    count++;
    previous = at;
    if (overlapping && count > SHOWN_MATCHES) return false;
    if (count > free) {
      if (!budget || budget.left <= 0) return !(spent = true);
      budget.left--;
    }
    return true;
  };
  if (accept) {
    // Run before the answer is made, since the answer reads what it counts.
    const stopped = !everyOccurrence(haystack, needle, take);
    return { starts, count, overlapping, atLeast: stopped, spent };
  }
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!take(at)) return { starts, count, overlapping, atLeast: true, spent };
  }
  return { starts, count, overlapping, atLeast: false, spent };
}

/**
 * Every position needle starts at in haystack, overlapping ones included,
 * each given to `visit` in turn until it returns false, in one pass over the
 * haystack however the needle repeats itself (Knuth–Morris–Pratt). False once
 * `visit` returns false, even for an occurrence that ends the haystack, as
 * scan's indexOf loop stops; true when every occurrence was visited.
 */
function everyOccurrence(haystack: string, needle: string, visit: (at: number) => boolean): boolean {
  // border[i]: how long the needle's longest prefix is that also ends its
  // first i + 1 code units, short of all of them.
  const border = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i++) {
    const c = needle.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = border[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    border[i] = k;
  }
  for (let i = 0, k = 0; i < haystack.length; i++) {
    const c = haystack.charCodeAt(i);
    while (k > 0 && c !== needle.charCodeAt(k)) k = border[k - 1]!;
    if (c === needle.charCodeAt(k)) k++;
    if (k === needle.length) {
      if (!visit(i - k + 1)) return false;
      k = border[k - 1]!;
    }
  }
  return true;
}

/**
 * The 1-based line of each index (ascending), in one pass over the text: it
 * keeps the next line end it found, so once none remains it reads no further.
 */
export function lineNumbersAt(value: string, indices: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let next = value.indexOf('\n');
  for (const index of indices) {
    while (next !== -1 && next < index) {
      line++;
      next = value.indexOf('\n', next + 1);
    }
    lines.push(line);
  }
  return lines;
}

/** How many of the ascending values are below x. */
function countBelow(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bigram counts of a string. */
function grams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < value.length; i++) {
    const gram = value.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Above this many UTF-16 code units of the text (line ends as LF) a miss gets
 * no closest-region hint: scoring every line would hold the host's event loop.
 */
export const HINT_MAX_CHARS = 2 * 1024 * 1024;

/**
 * What one call's misses may search for their closest regions, in UTF-16 code
 * units of file text, all of them together: as much as one edit's miss may
 * (HINT_MAX_CHARS), so the closest-region search of an edit_many call of many
 * misses holds the event loop no longer than one edit's could. Matching itself
 * scans each file once per edit, as any edit must, and what it counts past
 * what the edits need takes from the call's count budget (CountBudget).
 */
export interface HintBudget {
  left: number;
}
export const hintBudget = (): HintBudget => ({ left: HINT_MAX_CHARS });

/**
 * The file region most like the first meaningful line of the old text,
 * numbered for the retry, within the call's hint budget.
 */
function closestRegion(value: string, needle: string, budget: HintBudget): string {
  if (value.length > HINT_MAX_CHARS) {
    return `(No closest region for a file over ${HINT_MAX_CHARS.toLocaleString('en-US')} UTF-16 code units; find the text with grep.)`;
  }
  if (value.length > budget.left) {
    return `(No closest region: this call's other misses used its ${HINT_MAX_CHARS.toLocaleString('en-US')} UTF-16 code units of search; find the text with grep.)`;
  }
  budget.left -= value.length;
  // The first line with a bigram to score: a line of one character, such as
  // a closing brace, has none, and no line would score above it. At most its
  // first MAX_LINE_CHARS code units, as many as a hint shows of a line, so a
  // long old text holds no more than that.
  const first = needle
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 1) ?? needle.trim();
  const probe = first.slice(0, safeCut(first, MAX_LINE_CHARS));
  // Dice coefficient over character bigrams: cheap, order-sensitive enough for
  // "closest line". Each line's bigrams are counted against the probe's, by
  // a slot for each of the probe's, so what scoring holds follows the probe,
  // not the longest line.
  const slot = new Map<string, number>();
  const most: number[] = [];
  for (const [gram, n] of grams(probe)) {
    slot.set(gram, most.length);
    most.push(n);
  }
  const met = new Int32Array(most.length);
  const touched: number[] = [];
  const probeTotal = Math.max(0, probe.length - 1);
  const lines = value.split('\n');
  // A final line end ends the last line rather than starting an empty one, as
  // read numbers a file's lines.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  let best = 0;
  let bestScore = -1;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    let shared = 0;
    for (let at = 0; at + 1 < trimmed.length; at++) {
      const k = slot.get(trimmed.slice(at, at + 2));
      if (k === undefined) continue;
      if (met[k] === 0) touched.push(k);
      if (met[k]! < most[k]!) shared++;
      met[k] = met[k]! + 1;
    }
    for (const k of touched) met[k] = 0;
    touched.length = 0;
    const total = probeTotal + Math.max(0, trimmed.length - 1);
    const score = total ? (2 * shared) / total : 0;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (bestScore <= 0) return '';
  const from = Math.max(0, best - 3);
  const to = Math.min(lines.length, best + 4);
  // Every line comes before a line feed but a last one the text doesn't end with.
  const shown = lines.slice(from, to).map((line, k) => shownLine(line, from + k < lines.length - 1 || value.endsWith('\n')));
  return `Closest region (line ${best + 1}, similarity ${bestScore.toFixed(2)}):\n${numbered(shown, from + 1)}`;
}

/**
 * A line of the text edits are matched in, as an answer shows it: one whose
 * own text ends in a CR, before a line feed, shows its line end's CR too, as
 * read shows such a line. Matching reads a CR before a line feed in old text
 * as part of the line end, so text copied across the line with one CR would
 * match the same text with CRLF ends alone. In that text a CR before a line
 * feed is always such a line's own, since lineEnds made each CRLF a line feed.
 */
export function shownLine(text: string, beforeLf: boolean): string {
  return beforeLf && text.endsWith('\r') ? `${text}\r` : text;
}

/** How many matches a refusal names by line and shows. */
export const SHOWN_MATCHES = 20;
/** A matched line longer than this many UTF-16 code units is shown as an excerpt this long around its match. */
const EXCERPT_CHARS = 240;

/**
 * The lines the first matches fall on, numbered as read numbers them, each
 * line once: what a count refusal shows, so an over-broad match can be judged
 * without another read. A long line, such as a paragraph kept on one line, is
 * shown as an excerpt around its first match.
 */
function matchedLines(value: string, starts: number[], lines: number[]): string {
  const shown: string[] = [];
  let last = 0;
  starts.forEach((start, k) => {
    const line = lines[k]!;
    if (line === last) return;
    last = line;
    const lineFrom = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const newline = value.indexOf('\n', start);
    const lineTo = newline === -1 ? value.length : newline;
    let from = lineFrom;
    let to = lineTo;
    if (lineTo - lineFrom > EXCERPT_CHARS) {
      from = Math.max(lineFrom, start - EXCERPT_CHARS / 3);
      to = Math.min(lineTo, from + EXCERPT_CHARS);
      from = Math.max(lineFrom, to - EXCERPT_CHARS);
      // Never half of a surrogate pair at either cut.
      from = safeCut(value, from);
      to = safeCut(value, to);
    }
    shown.push(`${String(line).padStart(6)}\t${from > lineFrom ? '…' : ''}${shownLine(value.slice(from, to), to === lineTo && newline !== -1)}${to < lineTo ? '…' : ''}`);
  });
  return shown.join('\n');
}

/** Why an edit can't apply to its file, as the planner finds it. Edits are numbered by `index`, from 0. */
export type MatchProblem =
  /** The old text doesn't occur, even with straight and curly quotes treated as equal. */
  | { kind: 'miss'; edit: number; hint: string; crlf: boolean }
  /**
   * It occurs a number of times other than the one asked for, or its
   * occurrences overlap one another, or the call's count budget stopped its
   * count, which is then a floor, even at the number asked for.
   */
  | {
    kind: 'count';
    edit: number;
    expected: number | 'all';
    /**
     * How many times it occurs, or with `atLeast` how many the scan found
     * before it stopped: at an overlap, or with `spent` where the call's count
     * budget ran out (CountBudget).
     */
    found: number;
    atLeast: boolean;
    spent: boolean;
    /** The line of each of its first SHOWN_MATCHES occurrences, one per occurrence; `shown` shows each of those lines once. */
    lines: number[];
    shown: string;
    quoteNormalized: boolean;
    overlapping: boolean;
  }
  /** Two edits' matches overlap, or are the same text. */
  | { kind: 'clash'; edits: [number, number]; line: number; same: boolean }
  /**
   * Edits that found the occurrences they ask for, or stopped counting short
   * of them, asking between them for more than the text is long (`length`, in
   * UTF-16 code units with line ends as LF): each takes one or more, and one
   * edit's don't overlap one another, so some of different edits' would.
   * Named in place of their clashes, whose places aren't kept (planFile).
   */
  | { kind: 'crowded'; edits: number[]; asked: number; length: number }
  /**
   * It matches only without the BOM or the line end's CR its old text
   * carries (readForm), and without them it is the same as its new text.
   */
  | { kind: 'same'; edit: number }
  /**
   * Its old text, which carries the file's BOM at its start (`bom`) or a CR
   * at its end (`cr`), occurs in more than one reading, as given or without
   * either or both (readingsOf), so which the edit means can't be told. Each
   * reading's occurrences as a count's are: how many, and the lines of the
   * first SHOWN_MATCHES; `same` where read that way the edit changes
   * nothing, as the file keeps the BOM or line end's CR that reading leaves
   * out.
   */
  | {
    kind: 'readings';
    edit: number;
    bom: boolean;
    cr: boolean;
    readings: Array<{ leaves: Leaves; same: boolean; found: number; atLeast: boolean; lines: number[] }>;
  };

/** One replacement made, in the updated text. */
export interface Change {
  edit: number;
  /** Where its new text starts in the updated text, and that index's 1-based line. */
  at: number;
  line: number;
  /**
   * How many lines its new text spans, as a receipt shows them: a final line
   * end closes its last line rather than starting another.
   */
  lines: number;
}

/**
 * What one edit replaced in a file: its first replacement, which a receipt
 * shows, and where the rest fell, as far as a receipt names them. One edit
 * can make millions of replacements, so the rest are counted, not kept.
 */
export interface EditChanges {
  /** Its first replacement in the file. */
  first: Change;
  /** How many replacements it made. */
  count: number;
  /** The lines of its replacements after the first, each line once: the first SHOWN_MATCHES of them. */
  otherLines: number[];
  /** How many lines those replacements fall on in all, each line once. */
  otherLineCount: number;
}

/** A file's edits, applied together. */
export interface FilePlan {
  /** The file's new bytes, BOM and every line end it keeps included. */
  bytes: Buffer;
  /** Its new text with line ends as LF, for the receipt. */
  updated: string;
  /**
   * What each edit replaced, in the order of its first replacement in the
   * file: its first replacement, how many it made, and the lines of the rest
   * a receipt names, not the replacements themselves.
   */
  edits: EditChanges[];
  /** How many replacements the edits made in all. */
  replacements: number;
  /** The edits matched with straight and curly quotes treated as equal. */
  quoteNormalized: number[];
  /** The edits matched without the BOM or the line end's CR their old text carried (readingsOf). */
  readForm: number[];
  crlf: boolean;
  mixed: boolean;
  bom: boolean;
}

/**
 * Text built from many pieces, joined a batch at a time, so the pieces of a
 * replaceAll with millions of occurrences aren't all held at once.
 */
function textBuilder(): { add: (piece: string) => void; text: () => string } {
  const chunks: string[] = [];
  let pieces: string[] = [];
  const flush = () => {
    chunks.push(pieces.join(''));
    pieces = [];
  };
  return {
    add: (piece) => {
      if (!piece) return;
      pieces.push(piece);
      if (pieces.length >= 4096) flush();
    },
    text: () => {
      flush();
      return chunks.join('');
    },
  };
}

/** How many line feeds a string holds. */
function lineFeeds(value: string): number {
  let count = 0;
  for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) count++;
  return count;
}

/**
 * A file's edits applied together, or every problem that stops them. Each
 * edit is matched in the file's text as read: its old text must occur the
 * number of times it asks for, counting overlapping occurrences (so "aa"
 * occurs twice in "aaa"), and occurrences that overlap one another can't each
 * be replaced. An old text that carries the file's BOM at its start or a
 * line's CR at its end is also read without the one, the other or both
 * (readingsOf): one found in more than one reading, as given among them, is
 * refused, since which it means can't be told, a reading in which the edit
 * changes nothing included, and one found only in another reading, and there
 * the same as its new text, has nothing to change. An edit that replaces
 * every occurrence counts no reading in which it changes nothing or that
 * leaves nothing, since edits keep line ends and the BOM. Only where no
 * reading finds it is it matched again with straight and curly quotes
 * treated as equal. Two edits' matches may touch but not overlap. What a
 * call counts past what its edits need takes from its count budget
 * (CountBudget). Only the replaced text changes: every other byte stays as
 * it was, and each new text's line ends take, by position, those of the
 * text it replaces. For each occurrence an edit replaces it holds numbers,
 * not objects: the occurrence's start, and with several edits a key in one
 * Float64Array. The
 * new text is built a batch of pieces at a time, and of each edit's
 * replacements it keeps only what a receipt names. Two bounds keep a call
 * from holding more than its file: two or more edits whose asks, past what a
 * refusal shows, come to more occurrences than the text is long keep no more
 * starts than a refusal shows (one edit keeps the starts it finds, which the
 * text's length bounds), and a file whose counts take it past `maxBytes` is
 * refused as `tooLarge`, at least that many bytes, before its new text is
 * built. One that the CRLF ends its new text takes, or quotes read as equal,
 * take past it is built and returned, for its caller to refuse by its bytes.
 */
export function planFile(
  file: FileText,
  bytes: Buffer,
  specs: EditSpec[],
  hints: HintBudget = hintBudget(),
  maxBytes = Infinity,
  counts: CountBudget = countBudget(),
): { plan: FilePlan } | { problems: MatchProblem[] } | { tooLarge: number } {
  const { raw, value, crs, lfs } = file;
  const crlf = crs.length > 0;
  const mixed = crlf && crs.length < lfs;
  const crAt = (lf: number) => {
    const i = countBelow(crs, lf);
    return i < crs.length && crs[i] === lf;
  };
  const problems: MatchProblem[] = [];
  // Each edit that matches, with where: the edit as matched (readForm's for an
  // old text read without its BOM or CR), its starts, ascending, and how many.
  const applied: Array<{ spec: EditSpec; starts: number[]; count: number }> = [];
  const quoteNormalized: number[] = [];
  const readForms: number[] = [];
  let quoted: string | undefined;
  // Each edit keeps the starts it asks for, to replace them. What several ask
  // for past the SHOWN_MATCHES each keeps for a refusal has to fit in the
  // text, a character or more each; when it doesn't, they can't all apply
  // (one finds fewer than it asks for, or two overlap), so they keep only
  // what a refusal shows, and a call asking for millions of each doesn't
  // hold millions for each.
  const pastShown = specs.reduce((sum, spec) => sum + (spec.expected === 'all' ? 0 : Math.max(spec.expected - SHOWN_MATCHES, 0)), 0);
  const crowded = specs.length > 1 && pastShown > value.length;
  // The call's count budget holds as many as this text is long, at least:
  // applyEdits sizes it to the larger of the mount's limit and the largest
  // file the call names, and a caller that sizes it smaller has it raised
  // here.
  if (value.length > counts.size) {
    counts.left += value.length - counts.size;
    counts.size = value.length;
  }
  // Crowded edits whose counts stopped past what a refusal shows, and so
  // can't be set against what they ask for, each with its count problem,
  // made where the crowded check doesn't name it.
  const uncounted: Array<{ spec: EditSpec; problem: () => MatchProblem }> = [];
  for (const spec of specs) {
    // Every occurrence when every one is replaced; otherwise enough to replace or to show.
    const keep = crowded ? SHOWN_MATCHES : spec.expected === 'all' ? Infinity : Math.max(spec.expected, SHOWN_MATCHES);
    // What it counts freely: every occurrence it replaces, and the one more
    // that shows it finds more than it asks for. Past that, a count only makes
    // a refusal exact, and takes from the call's budget (CountBudget). Crowded
    // edits are refused whatever they find (below), so they count freely no
    // more than a refusal shows, but for one that replaces every occurrence,
    // which asks for as many as there are, and so counts them all.
    const free = spec.expected === 'all' ? Infinity : crowded ? SHOWN_MATCHES : Math.max(spec.expected, SHOWN_MATCHES) + 1;
    const budget = counts;
    let matched = spec;
    let { starts, count, overlapping, atLeast, spent } = scan(value, spec.oldText, keep, undefined, free, budget);
    let normalized = false;
    // An old text with the file's BOM at its start or a CR at its end reads
    // more ways than as given: without either, or both, as a character page
    // or a line shown with its CRLF end's CR gives it (readingsOf). A line
    // whose own text ends in one CR, shown with its end's, reads as given as a
    // line ending in two. Where more than one reading that changes something
    // finds it, which the edit means can't be told, so it's refused; where one
    // does, it's taken, before quotes are read as equal. That holds for one
    // that changes nothing, its new text read the same way as its old: a copy
    // of a line end's CR or the BOM, as a character page shows them, may mean
    // them, which the file keeps, and alone it has nothing to change. Beside a
    // match as given, a reading need only be found, and shown as a refusal
    // shows it. A reading that leaves nothing, of an old text that is the BOM
    // or a CR alone, is found where what it leaves out is the file's, the BOM
    // at the text's start and a CR before each CRLF line end; it counts only
    // beside another match, as an empty text can't be replaced. An edit that
    // replaces every occurrence counts neither: edits keep line ends and the
    // BOM, so where a reading changes nothing, or leaves nothing, it can only
    // mean the occurrences that change.
    const all = spec.expected === 'all';
    const emptyAt = (leaves: Leaves): number[] => (leaves === 'cr' ? crs : file.bom && (leaves === 'bom' || crAt(0)) ? [0] : []);
    const allReads = readingsOf(spec, file, crAt)
      .filter((read) => read.spec.oldText || !all)
      .map((read) => {
        if (read.spec.oldText) {
          return { read, found: count > 0 ? scan(value, read.spec.oldText, SHOWN_MATCHES, read.accept, SHOWN_MATCHES) : scan(value, read.spec.oldText, keep, read.accept, free, budget) };
        }
        const at = emptyAt(read.leaves);
        return { read, found: { starts: at.slice(0, SHOWN_MATCHES), count: at.length, overlapping: false, atLeast: false, spent: false } };
      })
      .filter(({ found }) => found.count > 0);
    const same = ({ read }: { read: { spec: EditSpec } }): boolean => read.spec.oldText === read.spec.newText;
    const counted = all ? allReads.filter((reading) => !same(reading)) : allReads;
    const others = (count > 0 ? 1 : 0) + counted.filter(({ read }) => read.spec.oldText).length;
    const reads = counted.filter(({ read }) => read.spec.oldText || others > 0);
    if (reads.length + (count > 0 ? 1 : 0) > 1) {
      const where = (found: Found) => ({ found: found.count, atLeast: found.atLeast, lines: lineNumbersAt(value, found.starts.slice(0, SHOWN_MATCHES)) });
      problems.push({
        kind: 'readings',
        edit: spec.index,
        bom: file.bom && spec.oldText.startsWith('\uFEFF'),
        cr: crlf && spec.oldText.endsWith('\r'),
        readings: [
          ...(count > 0 ? [{ leaves: 'nothing' as const, same: false, ...where({ starts, count, overlapping, atLeast, spent }) }] : []),
          ...reads.map((reading) => ({ leaves: reading.read.leaves, same: same(reading), ...where(reading.found) })),
        ],
      });
      continue;
    }
    if (count === 0 && reads.length === 1 && !same(reads[0]!)) {
      const { read, found: where } = reads[0]!;
      ({ starts, count, overlapping, atLeast, spent } = where);
      matched = read.spec;
      readForms.push(spec.index);
    } else if (count === 0 && reads.length < 2 && allReads.some((reading) => reading.read.spec.oldText && same(reading))) {
      // Read as the file's own, the BOM or CR was all the edit changed. A
      // reading that leaves nothing is never taken alone, so it misses.
      problems.push({ kind: 'same', edit: spec.index });
      continue;
    }
    if (count === 0) {
      ({ starts, count, overlapping, atLeast, spent } = scan((quoted ??= normalizeQuotes(value)), normalizeQuotes(spec.oldText), keep, undefined, free, budget));
      normalized = count > 0;
    }
    if (count === 0) {
      problems.push({ kind: 'miss', edit: spec.index, hint: closestRegion(value, spec.oldText, hints), crlf });
      continue;
    }
    // A count the budget stopped is a floor, and so isn't the one asked for
    // even where it's that many, which only a crowded edit's can be.
    if (overlapping || (spec.expected !== 'all' && (count !== spec.expected || spent))) {
      const found = { count, atLeast, spent, overlapping, normalized, first: starts.slice(0, SHOWN_MATCHES) };
      const problem = (): MatchProblem => {
        const lines = lineNumbersAt(value, found.first);
        return {
          kind: 'count',
          edit: spec.index,
          expected: spec.expected,
          found: found.count,
          atLeast: found.atLeast,
          spent: found.spent,
          lines,
          shown: matchedLines(value, found.first, lines),
          quoteNormalized: found.normalized,
          overlapping: found.overlapping,
        };
      };
      // A crowded edit whose count stopped at no more than it asks for may
      // find what it asks for: the crowded check below names it, or else its
      // count, as a floor.
      if (crowded && spent && !overlapping && count <= (spec.expected as number)) uncounted.push({ spec, problem });
      else problems.push(problem());
      continue;
    }
    if (normalized) quoteNormalized.push(spec.index);
    applied.push({ spec: matched, starts, count });
  }
  if (crowded) {
    // Where the edits that found what they ask for, and those whose counts
    // stopped short of it, ask between them for more occurrences than the
    // text is long, each takes one or more, so some overlap, though where
    // isn't kept: they're named as crowded. Otherwise some edit found other
    // than it asks for, and each that stopped short is named by its count,
    // which says it's a floor.
    // An edit that replaces every occurrence asks for as many as it found.
    const asks = [
      ...applied.map(({ spec, count }) => ({ edit: spec.index, asked: spec.expected === 'all' ? count : spec.expected })),
      ...uncounted.map(({ spec }) => ({ edit: spec.index, asked: spec.expected as number })),
    ].sort((a, b) => a.edit - b.edit);
    const asked = asks.reduce((sum, ask) => sum + ask.asked, 0);
    if (asked > value.length) problems.push({ kind: 'crowded', edits: asks.map((ask) => ask.edit), asked, length: value.length });
    // A loop, not a spread: a call's edits can be more than a spread passes.
    else for (const { problem } of uncounted) problems.push(problem());
    return { problems };
  }
  // Every replacement in file order. One edit's starts are that already; for
  // several, each replacement is a number, its start times the edits plus
  // the edit's slot, so sorting them sorts by start, then by the edit's place
  // in the call's list.
  applied.sort((a, b) => a.spec.index - b.spec.index);
  const slots = applied.length;
  const total = applied.reduce((sum, { starts }) => sum + starts.length, 0);
  let order: Float64Array | undefined;
  if (slots > 1) {
    order = new Float64Array(total);
    let k = 0;
    applied.forEach(({ starts }, slot) => {
      for (const start of starts) order![k++] = start * slots + slot;
    });
    order.sort();
  }
  const slotOf = (k: number) => (order ? order[k]! % slots : 0);
  const startOf = (k: number) => (order ? (order[k]! - (order[k]! % slots)) / slots : applied[0]!.starts[k]!);
  // Overlapping matches are named at their first overlap, whatever order the
  // list gave them in, and each edit at most once as the later of a pair, so
  // the problems grow with the edits rather than their pairs: a thousand edits
  // of one stretch are a thousand problems at most, not half a million. One
  // edit's own occurrences don't overlap (scan), so only several can clash.
  const named = new Set<number>();
  const pairs = new Set<string>();
  const clashes: Array<{ edits: [number, number]; at: number; same: boolean }> = [];
  // A later replacement whose edit is already named can't name it again, so
  // the first loop to meet it links past it (nextLater), and the loops after
  // cross a run of such replacements in one step: many edits matching one
  // text cost their replacements, not their pairs at every place.
  const nextLater = slots > 1 ? new Int32Array(total + 1) : undefined;
  for (let k = 0; nextLater && k <= total; k++) nextLater[k] = k;
  const laterFrom = (k: number): number => {
    let found = k;
    while (nextLater![found] !== found) found = nextLater![found]!;
    while (nextLater![k] !== found) {
      const step = nextLater![k]!;
      nextLater![k] = found;
      k = step;
    }
    return found;
  };
  for (let i = 0; slots > 1 && i < total; i++) {
    const first = applied[slotOf(i)]!.spec;
    const firstStart = startOf(i);
    const firstEnd = firstStart + first.oldText.length;
    for (let j = laterFrom(i + 1); j < total && startOf(j) < firstEnd; j = laterFrom(j + 1)) {
      const later = applied[slotOf(j)]!.spec;
      if (named.has(later.index)) {
        nextLater![j] = j + 1;
        continue;
      }
      const laterStart = startOf(j);
      const a = Math.min(first.index, later.index);
      const b = Math.max(first.index, later.index);
      if (a === b || pairs.has(`${a} ${b}`)) continue;
      named.add(later.index);
      pairs.add(`${a} ${b}`);
      clashes.push({ edits: [a, b], at: laterStart, same: laterStart === firstStart && laterStart + later.oldText.length === firstEnd });
    }
  }
  // Every clash's line in one pass over the text, rather than a pass each.
  const clashAts = [...new Set(clashes.map((clash) => clash.at))].sort((x, y) => x - y);
  const lineAt = new Map(lineNumbersAt(value, clashAts).map((line, k) => [clashAts[k]!, line]));
  for (const clash of clashes) problems.push({ kind: 'clash', edits: clash.edits, line: lineAt.get(clash.at)!, same: clash.same });
  if (problems.length) return { problems };

  // The new bytes are at least the file's, and for each replacement its new
  // text's, less the most its replaced text can take: its own bytes, in a
  // file with CRLF line ends one more for each line feed, which it may hold
  // as two, and matched with quotes read as equal, two more for each straight
  // quote, which a curly one takes as three. That's exact for a file with no
  // CRLF line end matched as given. So a file
  // the edits take past maxBytes is refused before its new text, which could
  // run to gigabytes, is built. One that this floor leaves within it but the
  // CRLF ends its new text takes, or its quotes, take past it is built, and
  // its caller refuses it by its bytes.
  const quotesRead = new Set(quoteNormalized);
  const straightQuotes = (text: string) => text.length - text.replace(/['"]/g, '').length;
  const leastBytes = applied.reduce((size, { spec, count }) => size + count * (Buffer.byteLength(spec.newText)
    - Buffer.byteLength(spec.oldText) - (crlf ? lineFeeds(spec.oldText) : 0) - (quotesRead.has(spec.index) ? 2 * straightQuotes(spec.oldText) : 0)), bytes.length);
  if (leastBytes > maxBytes) return { tooLarge: leastBytes };

  const endingAt = (lf: number) => (crAt(lf) ? '\r\n' : '\n');
  // The line end after a replaced text that holds none: its line's own, found
  // once per line as the matches ascend, or for an unterminated last line the
  // file's last one. Only a file with CRLF line ends asks, so it has one.
  let nextLf = -1;
  let lastLf: number | undefined;
  const lineEnding = (start: number) => {
    if (nextLf !== Infinity && nextLf < start) {
      const at = value.indexOf('\n', start);
      nextLf = at === -1 ? Infinity : at;
    }
    return endingAt(nextLf !== Infinity ? nextLf : (lastLf ??= value.lastIndexOf('\n')));
  };
  // The new text's line ends take, by position, the line ends of the text it
  // replaces: the k-th the k-th, any beyond them the last, so a mixed span
  // keeps its mixture. A match's line ends sit where oldText's do,
  // quote-normalized or not.
  const shapes = new Map<EditSpec, { oldBreaks: number[]; newPieces: string[] }>();
  const withEndings = (spec: EditSpec, start: number) => {
    if (!crlf) return spec.newText;
    let shape = shapes.get(spec);
    if (!shape) {
      const oldBreaks: number[] = [];
      for (let at = spec.oldText.indexOf('\n'); at !== -1; at = spec.oldText.indexOf('\n', at + 1)) oldBreaks.push(at);
      shapes.set(spec, (shape = { oldBreaks, newPieces: spec.newText.split('\n') }));
    }
    const { oldBreaks, newPieces } = shape;
    if (newPieces.length === 1) return spec.newText;
    const replaced = oldBreaks.length ? oldBreaks.map((k) => endingAt(start + k)) : [lineEnding(start)];
    let joined = newPieces[0]!;
    for (let k = 1; k < newPieces.length; k++) joined += replaced[Math.min(k - 1, replaced.length - 1)]! + newPieces[k]!;
    return joined;
  };
  // The CRs below an index of the text, counted as the replacements ascend:
  // each index asked is at or past the one before.
  let crsBelow = 0;
  const rawIndex = (i: number) => {
    while (crsBelow < crs.length && crs[crsBelow]! < i) crsBelow++;
    return i + crsBelow;
  };
  // What each edit's new text adds: its line feeds, and the lines a receipt
  // shows it on.
  const added = applied.map(({ spec }) => {
    const feeds = lineFeeds(spec.newText);
    return { feeds, lines: feeds + 1 - (spec.newText.endsWith('\n') ? 1 : 0) };
  });
  const out = textBuilder();
  const updated = textBuilder();
  const kept: Array<EditChanges | undefined> = applied.map(() => undefined);
  // The line of each edit's last replacement after its first; lines start at 1.
  const lastOther = applied.map(() => 0);
  let rawFrom = 0;
  let from = 0;
  let length = 0;
  // The updated text's line at `from`: the line feeds of the text kept before
  // it, and of each new text put in, counted as the replacements ascend. The
  // text's next line feed is kept as it's found, so text with none left is
  // read to its end once, not once per replacement.
  let line = 1;
  let nextFeed = value.indexOf('\n');
  const feedsBefore = (to: number) => {
    let feeds = 0;
    while (nextFeed !== -1 && nextFeed < to) {
      feeds++;
      nextFeed = value.indexOf('\n', nextFeed + 1);
    }
    return feeds;
  };
  for (let k = 0; k < total; k++) {
    const slot = slotOf(k);
    const { spec } = applied[slot]!;
    const start = startOf(k);
    out.add(raw.slice(rawFrom, rawIndex(start)));
    out.add(withEndings(spec, start));
    rawFrom = rawIndex(start + spec.oldText.length);
    updated.add(value.slice(from, start));
    updated.add(spec.newText);
    line += feedsBefore(start);
    length += start - from;
    const edit = kept[slot];
    if (!edit) {
      kept[slot] = { first: { edit: spec.index, at: length, line, lines: added[slot]!.lines }, count: 1, otherLines: [], otherLineCount: 0 };
    } else {
      edit.count++;
      // An edit's replacements ascend, so their lines never fall: a line
      // already counted is the last one.
      if (lastOther[slot] !== line) {
        lastOther[slot] = line;
        edit.otherLineCount++;
        if (edit.otherLines.length < SHOWN_MATCHES) edit.otherLines.push(line);
      }
    }
    length += spec.newText.length;
    line += added[slot]!.feeds;
    from = start + spec.oldText.length;
    // The old text's line feeds are replaced, not kept.
    feedsBefore(from);
  }
  out.add(raw.slice(rawFrom));
  updated.add(value.slice(from));
  return {
    plan: {
      bytes: Buffer.concat([file.bom ? bytes.subarray(0, 3) : Buffer.alloc(0), Buffer.from(out.text(), 'utf8')]),
      updated: updated.text(),
      edits: kept.filter((edit): edit is EditChanges => edit !== undefined).sort((a, b) => a.first.at - b.first.at),
      replacements: total,
      quoteNormalized,
      readForm: readForms,
      crlf,
      mixed,
      bom: file.bom,
    },
  };
}
