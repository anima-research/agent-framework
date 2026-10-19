/**
 * What the model reads when a foreground `code_execution` script ends.
 *
 * How the script ended comes first: its exit code, the time-limit note when
 * the call's limit was capped, the runner's own words when it has any, such
 * as why it stopped the script, and what the script's tool calls left
 * uncertain. stderr comes next, ahead of stdout: its end holds a traceback.
 * Within a budget, each stream is cut to its head and its tail around a count
 * of what was cut, and stderr keeps a share of the room of its own, so in any
 * budget that holds a cut of each stream, however long stdout runs, it can't
 * push how the script ended or stderr's end out of view.
 */

export interface ScriptEnd {
  stdout: string;
  stderr: string;
  returnCode: number;
  /** Set when the call's time_limit_ms was capped at the deployment's maximum. */
  timeLimitNote?: string;
  /** The runner's own words, when it has any (ExecResult.runnerNote); stderr goes without them (scriptStderr). */
  runnerNote?: string;
  /** What the script's tool calls left uncertain, when there's something to say (callsLine). */
  toolCalls?: string;
}

/** The whole text, nothing cut. */
export function scriptEndText(end: ScriptEnd): string {
  return heading(end) + section('stderr', end.stderr) + section('stdout', end.stdout);
}

/**
 * The text within `budget` characters. When the whole text is longer, stderr
 * keeps up to a third of the room the streams have, or more when stdout needs
 * less, and stdout takes the rest, each cut to its head and tail. stderr's
 * tail keeps its last line whole when the line fits its room. Returns null
 * when the streams' room is three cut markers or less, so that stderr's share,
 * when stderr is cut, keeps some of its own text beside its count.
 */
export function scriptEndTextWithin(end: ScriptEnd, budget: number): string | null {
  const whole = scriptEndText(end);
  if (whole.length <= budget) return whole;
  const { stderr, stdout } = end;
  const marker = cutMarker(Math.max(stderr.length, stdout.length)).length;
  const room = budget - heading(end).length - labelLength('stderr', stderr) - labelLength('stdout', stdout);
  if (room <= 3 * marker) return null;
  const stderrRoom = Math.min(stderr.length, Math.max(Math.ceil(room / 3), room - stdout.length));
  return heading(end)
    + section('stderr', cutMiddle(stderr, stderrRoom, true))
    + section('stdout', cutMiddle(stdout, room - stderrRoom));
}

function heading(end: ScriptEnd): string {
  return `exit code: ${end.returnCode}\n`
    + (end.timeLimitNote ? `time limit: ${end.timeLimitNote}\n` : '')
    + (end.runnerNote ? `${end.runnerNote}\n` : '')
    + (end.toolCalls ? `${end.toolCalls}\n` : '');
}

/** A stream under its label, ending in a newline; nothing for an empty stream. */
function section(name: string, body: string): string {
  if (body === '') return '';
  return `--- ${name} ---\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/** What a stream's section adds besides the stream itself, at most: its label and a closing newline. */
function labelLength(name: string, body: string): number {
  return body === '' ? 0 : `--- ${name} ---\n`.length + 1;
}

/** The count of what was cut, on a line of its own. */
function cutMarker(cut: number, afterLineEnd = false): string {
  return `${afterLineEnd ? '' : '\n'}[… ${cut} characters cut …]\n`;
}

/**
 * `text` in at most `keep` characters: its head and its tail around a count of
 * what was cut. Each cut falls at a line's end when one is near, within a
 * quarter of the part it ends, so a part line doesn't read as a whole one;
 * otherwise it falls mid-line, never inside a surrogate pair. With
 * `keepLastLine`, the tail is at least the last line when that line fits.
 * `keep` must hold the marker for a cut of `text.length`.
 */
function cutMiddle(text: string, keep: number, keepLastLine = false): string {
  if (text.length <= keep) return text;
  const left = keep - cutMarker(text.length).length;
  let headLength = Math.floor(left / 2);
  let tailLength = left - headLength;
  if (keepLastLine) {
    // The tail keeps the last line whole, taking from the head, when the
    // line fits; a longer one keeps its end. Blank lines at the end, LF or
    // CRLF, go with the line before them.
    let contentEnd = text.length;
    while (contentEnd > 0 && (text[contentEnd - 1] === '\n' || text[contentEnd - 1] === '\r')) contentEnd--;
    const lastLine = text.length - (text.lastIndexOf('\n', contentEnd - 1) + 1);
    if (lastLine > tailLength && lastLine <= left) {
      tailLength = lastLine;
      headLength = left - lastLine;
    }
  }
  let headEnd = headLength;
  const lineEnd = headEnd > 0 ? text.lastIndexOf('\n', headEnd - 1) : -1;
  if (lineEnd >= 0 && headEnd - (lineEnd + 1) <= headLength / 4) headEnd = lineEnd + 1;
  else if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
  let tailStart = text.length - tailLength;
  const lineStart = text.indexOf('\n', tailStart - 1) + 1;
  if (lineStart > 0 && lineStart - tailStart <= tailLength / 4) tailStart = lineStart;
  else if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
  const head = text.slice(0, headEnd);
  return head + cutMarker(tailStart - headEnd, head === '' || head.endsWith('\n')) + text.slice(tailStart);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
