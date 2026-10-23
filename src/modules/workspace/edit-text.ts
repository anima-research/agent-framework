/**
 * What edit and edit_many say: a refusal that names edit's problem, or each of
 * edit_many's problems in edit order, and a receipt that shows each edit's
 * first changed region. What can grow with a call, problems, notes, files and
 * regions, is held to the length the call's result may have
 * (ToolCall.resultMaxChars). Past it, a problem keeps its first line, a region
 * is named by its lines, and the answer's last line counts what it left out;
 * edit's receipt keeps its path and notes whatever their length.
 *
 * Ported from anima-research/hands-mcp's src/edit.ts, where it words the Edit
 * and EditMany tools' answers.
 */

import { type Change, type FilePlan, type Leaves, type MatchProblem, SHOWN_MATCHES } from './edit-plan.js';
import { MAX_LINE_CHARS, jsonLength, numberedLine, safeCut } from './text.js';

/** The tool a call came through, which words its refusals and receipt. */
export type EditTool = 'edit' | 'edit_many';

/**
 * Why a call stores nothing, as found before anything is stored. Edits are
 * numbered from 0 here, from 1 in what an agent reads.
 */
export type EditProblem =
  /** One edit's own input, checked before anything is read: an empty or unchanged text, a lone surrogate. */
  | { kind: 'input'; edit: number; text: string }
  /**
   * What stops a file's edits other than their matches: its path, its mount,
   * its stored copy. edit refuses with `text` alone where `whole`, as for a
   * file it can't find, and otherwise after "The edit did nothing: ".
   */
  | { kind: 'file'; edits: number[]; path: string; text: string; whole: boolean }
  /** The edits name files in more than one mount. */
  | { kind: 'mounts'; edits: number[]; mounts: string[] }
  | (MatchProblem & { path: string });

/** How many runs of edits a list names before it counts the rest. */
const LISTED_RUNS = 10;

/**
 * "edit 3", or "edits 1–4, 7 and 9", numbered from 1: three or more edits in a
 * row as a range, and past LISTED_RUNS of those and single edits, how many
 * more, so a label stays short whatever the call's size.
 */
export function editList(edits: number[]): string {
  const sorted = [...new Set(edits)].sort((a, b) => a - b).map((edit) => edit + 1);
  if (sorted.length === 1) return `edit ${sorted[0]}`;
  const items: string[] = [];
  let listed = 0;
  for (let i = 0; i < sorted.length && items.length < LISTED_RUNS;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const run = j - i >= 2;
    items.push(run ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    listed += run ? j - i + 1 : 1;
    i = run ? j + 1 : i + 1;
  }
  const more = sorted.length - listed;
  if (more > 0) return `edits ${items.join(', ')} and ${more} more`;
  return items.length === 1 ? `edits ${items[0]}` : `edits ${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * "line 5", "lines 5 and 9", "lines 5, 9 and 12", or "lines 5, 9 and 3
 * more": the lines shown, each once, of `total` lines in all.
 */
function lineList(shown: number[], total: number): string {
  const more = total - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more`
    : shown.length < 2 ? `${shown[0] ?? ''}` : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return `${plural(total, 'line')} ${list}`;
}

/** Each line once, the first SHOWN_MATCHES of them, and how many more, as lineList words them. */
function onLines(lines: number[]): string {
  const distinct = [...new Set(lines)];
  return lineList(distinct.slice(0, SHOWN_MATCHES), distinct.length);
}

/**
 * Where a count's occurrences are: the lines of those shown, each line once,
 * and whether more occurrences follow them.
 */
function countLines(problem: { found: number; atLeast: boolean; lines: number[] }): string {
  return problem.atLeast || problem.found > problem.lines.length
    ? `the first ${problem.lines.length} on ${onLines(problem.lines)}`
    : `on ${onLines(problem.lines)}`;
}

/**
 * The edit a problem sorts by: its first. A loop rather than Math.min's
 * spread, since a call's edits can be more than a spread passes as arguments.
 */
function firstEdit(problem: EditProblem): number {
  if (!('edits' in problem)) return problem.edit;
  let first = Infinity;
  for (const edit of problem.edits) if (edit < first) first = edit;
  return first;
}

const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

/** How a refusal names a reading of an old text, by what it leaves out (readingsOf). */
const READS: Record<Leaves, string> = {
  nothing: 'as given',
  cr: "with its last CR read as its CRLF line end's",
  bom: "with its BOM read as the file's own",
  both: "with its BOM read as the file's own and its last CR as a CRLF line end's",
};

/** A problem as an agent reads it, without the label edit_many puts before it. */
function problemText(problem: EditProblem, tool: EditTool): string {
  switch (problem.kind) {
    case 'input':
    case 'file':
      return problem.text;
    case 'mounts':
      return `the edits name files in more than one mount (${problem.mounts.join(', ')}); one call edits the files of one mount, so send the edits for each mount in a call of its own.`;
    case 'miss':
      return `oldString isn't in ${problem.path}.${problem.hint ? `\n${problem.hint}` : ''}\n`
        + `Match exactly, including whitespace and indentation${problem.crlf ? "; the file's CRLF line ends are matched as LF" : ''}.`;
    case 'count': {
      const { found, expected, overlapping } = problem;
      const occurs = `oldString occurs ${problem.atLeast ? 'at least ' : ''}${found} ${plural(found, 'time')} in ${problem.path} (${countLines(problem)})`;
      const quotes = problem.quoteNormalized ? ', with straight and curly quotes treated as equal' : '';
      const overlap = overlapping ? ", and they overlap, so they can't each be replaced" : '';
      if (tool === 'edit') {
        const hint = overlapping
          ? 'Add the text around it to single out the text you mean.'
          : 'Add the text around it to make it unique, or set replaceAll to replace every one.';
        return `${occurs}${quotes}${overlap}. ${hint}\n${problem.shown}`;
      }
      // A count the scan stopped at is a floor, which differs from the one
      // asked for only where it passes it.
      const differs = typeof expected === 'number' && (problem.atLeast ? found > expected : found !== expected);
      const hint = overlapping
        ? 'Include more of the text around it to single out the text you mean.'
        : problem.spent && !differs
          ? `Whether it occurs the ${expected} ${plural(expected as number, 'time')} it asks for can't be told from this call.`
          : problem.spent
            ? `Include more of the text around it to single out the ${expected === 1 ? 'one' : 'ones'} you mean.`
          : typeof expected === 'number' && found > expected
            ? `Include more of the text around it to single out the ${expected === 1 ? 'one' : 'ones'} you mean, or set occurrences to ${found} if every one should change.`
            : `Set occurrences to ${found} if those are all.`;
      // Why a count is a floor goes on a line of its own, so it doesn't push
      // the hint past the first line's cut (cutLine).
      const floor = problem.spent && !overlapping
        ? `This call counted as many occurrences as one call may, so ${found} is a floor: sent in a call of its own, the edit has every one counted, unless they overlap.\n`
        : '';
      return `${occurs}${quotes}${differs ? `, not ${expected}` : ''}${overlap}. ${hint}\n${floor}${problem.shown}`;
    }
    case 'clash': {
      const [a, b] = problem.edits;
      return problem.same
        ? `edits ${a + 1} and ${b + 1} replace the same text in ${problem.path} (line ${problem.line}); give each its own stretch of text.`
        : `edits ${a + 1} and ${b + 1} overlap in ${problem.path} (from line ${problem.line}); give each its own stretch of text, or make them one edit.`;
    }
    case 'crowded':
      return `they ask for ${problem.asked.toLocaleString('en-US')} occurrences between them in ${problem.path}, whose text, with its line ends read as LF, is ${problem.length.toLocaleString('en-US')} UTF-16 code units long, `
        + 'so some of their matches would overlap; give each its own stretch of text.';
    case 'same':
      return `oldString and newString are the same once the BOM or the line end's CR that oldString carries is read as ${problem.path}'s own, which the file keeps, so there's nothing to change.`;
    case 'readings': {
      const carries = problem.bom && problem.cr ? 'starts with a BOM and ends in a CR' : problem.bom ? 'starts with a BOM' : 'ends in a CR';
      const ways = problem.readings.map((reading) => `${READS[reading.leaves]} (${countLines(reading)})`);
      const list = ways.length < 3 ? ways.join(' and ') : `${ways.slice(0, -1).join(', ')} and ${ways.at(-1)}`;
      // A reading that changes nothing means the file's own BOM or line end's
      // CR, which an edit can't change, so the refusal says so.
      const same = problem.readings.filter((reading) => reading.same);
      const kept = [same.some((reading) => reading.leaves !== 'cr') && 'BOM', same.some((reading) => reading.leaves !== 'bom') && 'line ends'].filter(Boolean).join(' and ');
      // The lines of each reading follow on a line of their own, so however
      // long they run, they don't push the hint past the first line's cut
      // (cutLine).
      return `oldString ${carries}, and occurs in ${problem.path} read more than one way, so which you mean can't be told. `
        + `Include more of the text around it, such as the line before or after it, to say which.\nIt occurs ${list}.`
        + (same.length ? `\nWhere it occurs ${same.map((reading) => READS[reading.leaves]).join(' or ')}, the edit changes nothing, since the file keeps its ${kept}.` : '');
    }
  }
}

/** The label edit_many puts before a problem: its edits, or none for a clash, which names its own. */
function label(problem: EditProblem): string {
  if (problem.kind === 'clash' || problem.kind === 'mounts') return '';
  return `${'edits' in problem ? editList(problem.edits) : editList([problem.edit])}: `;
}

/**
 * A part's first line past this many UTF-16 code units is cut, so one long
 * path or text can't take the room the parts after it need.
 */
const FIRST_LINE_MAX = 400;

/**
 * What an answer is: a refusal, whose problems the agent answers and sends
 * again; the answer to edits stored, which mustn't be sent again; or, on a
 * direct mount, the answer to an edit_many call written partway, whose parts
 * are each file's outcome.
 */
export type AnswerKind = 'refusal' | 'stored' | 'written';

/** A line cut to FIRST_LINE_MAX, as a part's first line is, and as a thrown message is in an answer's head. */
export function cutLine(line: string): string {
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, safeCut(line, FIRST_LINE_MAX - 1))}…` : line;
}

/**
 * The answer's last line: what it left out, and what to do. `cut` parts left
 * out their details; `problems` and `notes` weren't shown at all. A refusal
 * that leaves out problems, and shows at least one, says to answer those
 * shown and send the call again to see the rest: once those are answered,
 * their room can show the rest, details included. For edits stored, the
 * problems are the files disk refused, and a last line that leaves some out
 * points to ls. For edits written partway, they're each file's outcome, and
 * one that leaves some out points to read.
 */
function tailText(kind: AnswerKind, maxChars: number, cut: number, problems: number, notes: number, anyShown: boolean): string {
  const items = [
    ...(cut ? [`the details of ${cut} of these`] : []),
    ...(problems
      ? [kind === 'refusal'
        ? `${problems} more ${plural(problems, 'problem')}`
        : kind === 'stored' ? `${problems} more ${plural(problems, 'file')} disk refused` : `the outcomes of ${problems} more ${plural(problems, 'file')}`]
      : []),
    ...(notes ? [`${notes} ${plural(notes, 'note')} on the files' copies on disk`] : []),
  ];
  if (!items.length) return '';
  const next = kind === 'stored'
    ? problems ? " ls shows each path's state." : ''
    : kind === 'written'
      ? problems ? ' Reading a file shows it as disk has it now.' : ''
      : problems && anyShown ? ' Answer the problems shown and send the call again to see the rest.' : '';
  const list = items.length < 2 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `[To keep this answer within ${maxChars.toLocaleString('en-US')} characters, it leaves out ${list}.${next}]`;
}

/**
 * An answer's head, then its parts joined with blank lines, within
 * `maxChars`: every part's first line while they fit, each cut at
 * FIRST_LINE_MAX, so a call's problems are each named before any is
 * explained, then, in order, the rest of each part whose rest still fits. The
 * parts are `problems`, for edits stored the files disk refused, then `notes`
 * on what the call's settling with disk found. A part whose first line
 * doesn't fit is left out with every part after it. The last line counts
 * what was left out, and for edits stored it never says to send the call
 * again. Never longer than `maxChars`, unless the
 * head and the last line alone are: with 1,000 characters, the least a
 * residence or an agent can set, a refusal names its first problem at least.
 */
export function fitted(head: string, problems: string[], notes: string[], maxChars: number, kind: AnswerKind): string {
  const parts = [...problems, ...notes];
  // The last line as long as it can be: every count at its most.
  const reserve = tailText(kind, maxChars, parts.length, problems.length, notes.length, true).length + 2;
  let left = maxChars - head.length - reserve;
  const shown: string[] = [];
  for (const part of parts) {
    const end = part.indexOf('\n');
    const line = end === -1 ? part : part.slice(0, end);
    const first = cutLine(line);
    // Each part costs the blank line before it too.
    if (first.length + 2 > left) break;
    left -= first.length + 2;
    shown.push(first);
  }
  let cut = 0;
  for (const [i, first] of shown.entries()) {
    const rest = parts[i]!.length - first.length;
    if (rest === 0) continue;
    if (rest > left) {
      cut++;
      continue;
    }
    left -= rest;
    shown[i] = parts[i]!;
  }
  const unshownProblems = Math.max(0, problems.length - shown.length);
  const tail = tailText(kind, maxChars, cut, unshownProblems, parts.length - shown.length - unshownProblems, shown.length > 0);
  return [head, ...shown, tail].filter(Boolean).join('\n\n');
}

/**
 * The refusal, within `maxChars`. edit names its first problem after "The
 * edit did nothing: ", unless it is a whole sentence already. edit_many
 * counts its problems and names each, in edit order, labelled with its edits.
 * `notes` follow the problems: which copy of a file the edits looked in, and
 * a conflict with disk, which the agent needs whether or not the call stored
 * anything. On a direct mount, whose edits go to disk with no store between
 * (`verb` 'wrote'), edit_many says it wrote none.
 */
export function refusalText(tool: EditTool, problems: EditProblem[], notes: string[], maxChars: number, verb: 'stored' | 'wrote' = 'stored'): string {
  const sorted = [...problems].sort((a, b) => firstEdit(a) - firstEdit(b));
  if (tool === 'edit') {
    const [problem] = sorted;
    const text = problemText(problem!, tool);
    const whole = problem!.kind === 'file' && problem!.whole ? text : `The edit did nothing: ${text}`;
    return fitted('', [whole], notes, maxChars, 'refusal');
  }
  const head = `The edit_many call ${verb} none of its edits: ${sorted.length} ${plural(sorted.length, 'problem')}.`;
  return fitted(head, sorted.map((problem) => `${label(problem)}${problemText(problem, tool)}`), notes, maxChars, 'refusal');
}

/** Lines from..to of the updated text, and their text's bounds in it. */
interface Region {
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * The region a receipt shows around a change: two lines before it, its new
 * text's lines, and two after, found by scanning for line ends around it,
 * never past the file's end.
 */
function regionOf(updated: string, change: Change): Region {
  const lineStart = (at: number) => (at === 0 ? 0 : updated.lastIndexOf('\n', at - 1) + 1);
  let start = lineStart(change.at);
  let from = change.line;
  for (let k = 0; k < 2 && start > 0; k++) {
    start = lineStart(start - 1);
    from--;
  }
  let end = lineStart(change.at);
  let to = change.line - 1;
  for (let k = 0; k < change.lines + 2 && end < updated.length; k++) {
    const newline = updated.indexOf('\n', end);
    end = newline === -1 ? updated.length : newline + 1;
    to++;
  }
  return { from, to, start, end };
}

/** How much of a long line an excerpt shows before the change it's for. */
const CHANGE_LEAD = 80;

/**
 * A line too long to show whole, numbered, as a stretch for each change the
 * receipt shows that starts on it (an edit's first change), at the ascending
 * `columns`: from at most CHANGE_LEAD
 * characters before the change, for as much as read shows of a line.
 * Stretches that meet run together, and each stretch of the line left out is
 * marked with how many characters it holds.
 */
function excerptLine(line: string, n: number, columns: number[]): string {
  const stretches: Array<{ from: number; to: number }> = [];
  for (const column of columns) {
    // safeCut takes a cut at or before 0 as 0.
    const from = safeCut(line, column - CHANGE_LEAD);
    const to = safeCut(line, from + MAX_LINE_CHARS);
    const last = stretches.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else stretches.push({ from, to });
  }
  let text = '';
  let shownTo = 0;
  for (const { from, to } of stretches) {
    if (from > shownTo) text += shownTo === 0 ? `[… ${from} chars before] ` : ` [… ${from - shownTo} chars] `;
    text += line.slice(from, to);
    shownTo = to;
  }
  if (shownTo < line.length) text += ` [… ${line.length - shownTo} more chars]`;
  return `${String(n).padStart(6)}\t${text}`;
}

/**
 * Each edit's first change in a file, as numbered regions merged where they
 * meet, while the budget lasts, counted as the answer's JSON holds them; past
 * it, the regions are named by their lines.
 */
export function shownRegions(plan: FilePlan, budget: { left: number }, maxChars: number): string[] {
  const firsts = plan.edits.map((edit) => edit.first).sort((a, b) => a.at - b.at);
  const regions: Region[] = [];
  for (const change of firsts) {
    // An emptied file's region holds no line, and shows as nothing.
    const region = regionOf(plan.updated, change);
    const last = regions.at(-1);
    if (last && region.from <= last.to + 1) {
      last.to = Math.max(last.to, region.to);
      last.end = Math.max(last.end, region.end);
    } else regions.push(region);
  }
  // A line shows as the stored bytes hold it, its CRLF end's CR left out
  // unless the line's own text ends in a CR, as a line of the old text shows
  // (shownLine). A CR before a line feed in the updated text is the line's
  // own, unless the edit put it before a bare LF: on disk the two are then a
  // CRLF end, and the line's own text doesn't end in it. The new bytes tell
  // these apart by the CRs before the line feed, read only for a line whose
  // text ends in a CR, at a place that moves forward with the regions' lines.
  // A file's line n is line n of its bytes, since both hold the same line
  // feeds, and a BOM's bytes are neither a line feed nor a CR.
  let byteAt = 0;
  let byteLine = 1;
  const asStored = (text: string, n: number, beforeLf: boolean): string => {
    if (!beforeLf || !text.endsWith('\r')) return text;
    for (; byteLine < n; byteLine++) byteAt = plan.bytes.indexOf(10, byteAt) + 1;
    const lf = plan.bytes.indexOf(10, byteAt);
    let own = 0;
    while (own < text.length && text.charCodeAt(text.length - 1 - own) === 13) own++;
    let stored = 0;
    while (stored <= own && lf - 1 - stored >= byteAt && plan.bytes[lf - 1 - stored] === 13) stored++;
    // A CRLF end after the line's own CRs; or a bare LF, whose last CR read
    // takes as the end's unless another comes before it.
    if (stored > own) return `${text}\r`;
    return own > 1 ? text : text.slice(0, -1);
  };
  const out: string[] = [];
  const omitted: string[] = [];
  for (const region of regions) {
    // The region's lines, numbered, built one at a time while they fit, so a
    // region of millions of lines, which is named by its lines, isn't built
    // whole first. The line before it ("…" between regions, or the line end)
    // counts too, and each line feed between its lines.
    let cost = out.length ? jsonLength('\n…\n') : jsonLength('\n');
    const lines: string[] = [];
    let fits = !omitted.length;
    for (let lineStart = region.start, n = region.from; fits && lineStart < region.end; n++) {
      const newline = plan.updated.indexOf('\n', lineStart);
      const lineEnd = newline === -1 || newline >= region.end ? region.end : newline;
      const text = asStored(plan.updated.slice(lineStart, lineEnd), n, lineEnd === newline);
      // A line too long to show whole shows its start, or, where edits' first
      // changes start on it, a stretch from shortly before each.
      const columns = text.length > MAX_LINE_CHARS ? firsts.filter((first) => first.line === n).map((first) => first.at - lineStart) : [];
      const numberedText = columns.length ? excerptLine(text, n, columns) : numberedLine(text, n);
      cost += jsonLength(numberedText) + (lines.length ? jsonLength('\n') : 0);
      if (cost > budget.left) fits = false;
      else lines.push(numberedText);
      lineStart = lineEnd + 1;
    }
    if (fits) {
      budget.left -= cost;
      if (out.length) out.push('…');
      out.push(lines.join('\n'));
    } else {
      budget.left = 0;
      omitted.push(region.from === region.to ? `${region.from}` : `${region.from}–${region.to}`);
    }
  }
  if (omitted.length) {
    const listed = omitted.slice(0, SHOWN_MATCHES);
    out.push(regionsLeftOut(maxChars, listed, omitted.length - listed.length, omitted.length === 1 && !omitted[0]!.includes('–')));
  }
  return out;
}

/** The note naming the regions of a file a receipt leaves out: the lines of SHOWN_MATCHES at most, and how many more. */
function regionsLeftOut(maxChars: number, listed: string[], more: number, oneLine: boolean): string {
  return `[not shown, to keep this answer within ${maxChars.toLocaleString('en-US')} characters: ${plural(oneLine ? 1 : 2, 'line')} ${listed.join(', ')}${more ? `, and ${more} more` : ''}]`;
}

/**
 * edit_many's last line, counting what its receipt leaves out: files it
 * doesn't list, and of those it lists, the regions, notes and edit numbers it
 * doesn't show. Null when it leaves out nothing.
 */
function filesLeftOut(maxChars: number, total: number, counts: { notListed: number; unshown: number; notes: number; edits: number }): string | null {
  const left = [
    ...(counts.notListed ? [`${counts.notListed} of the call's ${total} ${plural(total, 'file')}`] : []),
    ...(counts.unshown ? [`the changed regions of ${counts.unshown} more ${plural(counts.unshown, 'file')}`] : []),
    ...(counts.notes ? [`the notes of ${counts.notes} ${plural(counts.notes, 'file')}`] : []),
    ...(counts.edits ? [`the edit numbers of ${counts.edits} ${plural(counts.edits, 'file')}`] : []),
  ];
  if (!left.length) return null;
  const list = left.length < 2 ? left[0] : `${left.slice(0, -1).join(', ')} and ${left.at(-1)}`;
  return `[To keep this answer within ${maxChars.toLocaleString('en-US')} characters, it leaves out ${list}.]`;
}

/** A receipt's note on a file's line ends, if they need one. */
export function lineEndNote(plan: FilePlan): string | null {
  if (plan.mixed) return "The file's mixed line ends are kept: the new text's line ends take those of the text it replaces, by position.";
  return plan.crlf ? "The file's CRLF line ends are kept." : null;
}

/**
 * The lines of each edit's replacements after its first, for a receipt: the
 * first SHOWN_MATCHES edits that made more than one, and how many more did.
 */
export function otherReplacements(plan: FilePlan, labelled: boolean): string[] {
  const notes: string[] = [];
  let more = 0;
  for (const edit of [...plan.edits].sort((a, b) => a.first.edit - b.first.edit)) {
    if (edit.count < 2) continue;
    if (notes.length === SHOWN_MATCHES) {
      more++;
      continue;
    }
    const lines = lineList(edit.otherLines, edit.otherLineCount);
    notes.push(labelled ? `Edit ${edit.first.edit + 1}'s other replacements are on ${lines}.` : `The other replacements are on ${lines}.`);
  }
  if (more) notes.push(`${more} more ${plural(more, 'edit')} made other replacements too.`);
  return notes;
}

/**
 * A file a receipt describes: its mount-prefixed path as disk spells it, its
 * plan, what the call's settling found of it, and, where its push left the
 * file's mode as disk had it, why (commitToolChange's `modeKept`).
 */
export interface StoredFile {
  path: string;
  plan: FilePlan;
  notes: string[];
  modeKept?: string | null;
}

/**
 * What a receipt keeps aside for what it adds after its budget is spent, at
 * its longest for this call, as fitted keeps a refusal's last line: the note
 * naming the regions of the one file whose regions pass the budget, which
 * lists SHOWN_MATCHES of them at most, each as wide as that file's last
 * region line could be, and counts the rest. A file has a region for each
 * edit at most, and a region ends at most two lines past its change's new
 * text (regionOf). Then edit_many's last line, every count at its most. Each
 * with the line feed or blank line before it.
 */
function receiptReserve(tool: EditTool, files: StoredFile[], maxChars: number): number {
  let regions = 0;
  for (const { plan } of files) {
    if (!plan.edits.length) continue;
    let last = 1;
    for (const { first } of plan.edits) last = Math.max(last, first.line + first.lines + 1);
    const listed = Math.min(SHOWN_MATCHES, plan.edits.length);
    const range = `${last}–${last}`;
    const note = regionsLeftOut(maxChars, Array.from({ length: listed }, () => range), plan.edits.length - listed, false);
    regions = Math.max(regions, jsonLength('\n') + jsonLength(note));
  }
  if (tool === 'edit') return regions;
  const most = files.length;
  return regions + jsonLength('\n\n') + jsonLength(filesLeftOut(maxChars, most, { notListed: most, unshown: most, notes: most, edits: most })!);
}

/**
 * The receipt of edits stored: each file's size, replacements and notes, and
 * each edit's first changed region, numbered as read numbers lines, held to
 * `maxChars` as the answer's JSON holds it. Its counts and notes come first;
 * the regions take what is left, and past it a file's regions are named by
 * their lines. edit_many lists its files while they fit, a file whose notes
 * don't fit without them, or without its edits' numbers too, and counts the
 * rest. edit's receipt, of one file, keeps its counts and notes and shows no
 * region where those alone pass `maxChars`.
 */
export function editReceipt(tool: EditTool, files: StoredFile[], editCount: number, maxChars: number): Record<string, unknown> {
  const reserve = receiptReserve(tool, files, maxChars);
  const notesOf = ({ plan, notes }: StoredFile): string[] => {
    const lineEnds = lineEndNote(plan);
    return [
      ...notes,
      ...(plan.quoteNormalized.length
        ? [`${tool === 'edit' ? 'The text' : capitalized(editList(plan.quoteNormalized))} matched with straight and curly quotes treated as equal.`]
        : []),
      ...(plan.readForm.length
        ? [`${tool === 'edit' ? 'The text' : capitalized(editList(plan.readForm))} matched without the BOM or the line end's CR `
          + `${tool === 'edit' ? 'it' : plan.readForm.length === 1 ? 'its old text' : 'their old text'} carried, which the file keeps.`]
        : []),
      ...(lineEnds !== null ? [lineEnds] : []),
      ...otherReplacements(plan, tool === 'edit_many'),
    ];
  };
  if (tool === 'edit') {
    const file = files[0]!;
    const notes = notesOf(file);
    const data: Record<string, unknown> = {
      path: file.path,
      size: file.plan.bytes.length,
      replacements: file.plan.replacements,
      ...(notes.length ? { note: notes.join(' ') } : {}),
      ...(file.modeKept ? { modeKept: file.modeKept } : {}),
      changed: '',
    };
    const budget = { left: maxChars - JSON.stringify(data).length - reserve };
    data.changed = shownRegions(file.plan, budget, maxChars).join('\n');
    return data;
  }
  const listed: Array<Record<string, unknown>> = [];
  const data: Record<string, unknown> = {
    edits: editCount,
    replacements: files.reduce((sum, file) => sum + file.plan.replacements, 0),
    files: listed,
    changed: '',
  };
  const fits = (entry: Record<string, unknown>) => {
    listed.push(entry);
    const fit = JSON.stringify(data).length <= maxChars - reserve;
    listed.pop();
    return fit;
  };
  let notesLeftOut = 0;
  let editsLeftOut = 0;
  let notListed = 0;
  for (const [i, file] of files.entries()) {
    const notes = notesOf(file);
    const bare = {
      path: file.path,
      size: file.plan.bytes.length,
      replacements: file.plan.replacements,
      ...(file.modeKept ? { modeKept: file.modeKept } : {}),
    };
    const edits = file.plan.edits.map((edit) => edit.first.edit + 1).sort((a, b) => a - b);
    // The fullest entry that fits: with its notes, then without them, then
    // without its edits' numbers too, so a file is named before it's counted.
    const entry = [
      ...(notes.length ? [{ ...bare, edits, note: notes.join(' ') }] : []),
      { ...bare, edits },
      bare,
    ].find(fits);
    if (!entry) {
      notListed = files.length - i;
      data.filesNotListed = notListed;
      break;
    }
    listed.push(entry);
    if (notes.length && !('note' in entry)) notesLeftOut++;
    if (!('edits' in entry)) editsLeftOut++;
  }
  const budget = { left: maxChars - JSON.stringify(data).length - reserve };
  const sections: string[] = [];
  let unshown = 0;
  for (const file of files.slice(0, listed.length)) {
    const heading = jsonLength(`${file.path}\n`) + (sections.length ? jsonLength('\n\n') : 0);
    if (heading >= budget.left) {
      unshown++;
      continue;
    }
    budget.left -= heading;
    sections.push(`${file.path}\n${shownRegions(file.plan, budget, maxChars).join('\n')}`);
  }
  const last = filesLeftOut(maxChars, files.length, { notListed, unshown, notes: notesLeftOut, edits: editsLeftOut });
  if (last !== null) sections.push(last);
  data.changed = sections.join('\n\n');
  return data;
}

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
