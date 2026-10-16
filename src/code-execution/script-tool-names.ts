/**
 * Which of some tools a code_execution script names, and which of them it
 * leaves reachable by a later script in the same interpreter, read past the
 * script's comments and string literals as Python reads them. The framework
 * holds a script's round for the names it returns, and marks the agent's
 * interpreter with the reachable ones (AgentFramework.scriptMayRoute).
 *
 * A script reaches a tool through a function named for it (the tool's name,
 * after any prefix joined with `__`) or a `tools[...]` key. So a name counts
 * in code wherever it stands as a whole identifier: after a character other
 * than an ASCII letter, digit or underscore, or after `__`, and before such a
 * character. `say_hello` and `my_say` don't name `say`; `mcpl__world__say(`
 * does. A comment names nothing, since Python never runs one. A name anywhere
 * in a string counts, an escape before it read as a break, since a string
 * can be a key or code passed to eval or exec.
 *
 * A script leaves a tool reachable when it names the tool other than in a
 * direct call (an alias, a reference), names it inside a definition, whose
 * body runs later, when it's called (a def's header and indented block, a
 * class's methods among them, or a lambda), or keeps a string that is the
 * tool's whole name, optionally namespaced, as a key kept for later is. A
 * key called at once, as in `tools["world--say"](…)`, is a direct call. A
 * direct call outside a definition leaves nothing reachable, a class's own
 * body included, since it runs as the class statement does, and so does a
 * string that only mentions a tool, as a printed sentence does.
 *
 * Some reaches go unseen, such as a tool name the code doesn't spell out
 * (built at runtime, written with escapes, or in non-ASCII spellings), code
 * loaded from a file or module, an enumeration of the tools, a call written
 * in a string's text (code a script runs with exec or eval, or an f-string's
 * field), inside a definition too, a definition or alias made inside such a
 * string, a call that outlives its script (one it awaits only in a later
 * script, schedules as a task, or leaves in a generator expression), and
 * code a later script runs from a string an earlier one kept.
 *
 * @param tools plain tool names, of identifier characters
 */
export function scriptToolNames(script: string, tools: readonly string[]): { names: Set<string>; reachable: Set<string> } {
  if (tools.length === 0) return { names: new Set(), reachable: new Set() };
  const named = new RegExp(`(?:(?<![A-Za-z0-9_])|(?<=__))(${tools.join('|')})(?![A-Za-z0-9_])`, 'g');
  const key = new RegExp(`^(?:[A-Za-z0-9_-]*(?:--|__))?(${tools.join('|')})$`);
  const { code, strings } = readScript(script);
  const inDefinition = definitions(script, code, strings);
  const names = new Set<string>();
  const reachable = new Set<string>();
  for (const match of code.matchAll(named)) {
    names.add(match[1]);
    CALLED.lastIndex = match.index + match[0].length;
    if (!CALLED.test(code) || inDefinition(match.index)) reachable.add(match[1]);
  }
  for (const { text, start, end } of strings) {
    // The name itself counts as any name in a string does, just below.
    const whole = key.exec(text);
    if (whole) {
      KEY_CALLED.lastIndex = end;
      if (!KEY_CALLED.test(code) || inDefinition(start)) reachable.add(whole[1]);
    }
    for (const match of text.replace(ESCAPE, ' ').matchAll(named)) names.add(match[1]);
  }
  return { names, reachable };
}

/** A direct call right after a name in code: `(`, on the same line. */
const CALLED = /[ \t]*\(/y;
/** A direct call right after a key: a `tools[...]` subscript's close and then `(`, on the same line. */
const KEY_CALLED = /[ \t]*\][ \t]*\(/y;
/** A backslash escape in a string's text, which a name after it follows as it would a break. */
const ESCAPE = /\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|N\{[^}]*\}|[0-7]{1,3}|[\s\S])/g;

/**
 * Whether an offset of a script's code falls inside a definition, whose body
 * runs later, when it's called: a def's header and the indented block after
 * it, or a lambda from its keyword to the end of its logical line. A line's
 * indent is read from the script itself, so a line that opens with a string
 * stands where it's written. A line inside brackets, after a backslash, or
 * inside a string literal that an earlier line opened continues the line
 * before it, whatever its indentation; and a line holding only whitespace (a
 * carriage return included) or a comment doesn't end a block.
 */
function definitions(
  script: string,
  code: string,
  strings: readonly { start: number; end: number }[],
): (offset: number) => boolean {
  const lines: { start: number; text: string; indent: number; blank: boolean; continued: boolean }[] = [];
  let depth = 0;
  let continued = false;
  let start = 0;
  for (const text of code.split('\n')) {
    const written = script.slice(start, start + text.length);
    const indent = /^[ \t]*/.exec(written)![0].length;
    const blank = /^\s*(?:#[^\n]*)?$/.test(written);
    const inString = strings.some((s) => s.start < start && start < s.end);
    lines.push({ start, text, indent, blank, continued: continued || depth > 0 || inString });
    for (const c of text) {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    }
    continued = text.trimEnd().endsWith('\\');
    start += text.length + 1;
  }
  const startOf = (j: number) => (j < lines.length ? lines[j].start : code.length);
  const spans: [number, number][] = [];
  lines.forEach((line, i) => {
    if (line.continued || !/^[ \t]*(?:async[ \t]+)?def\b/.test(line.text)) return;
    // The header's own continued lines, then the block indented under it.
    let j = i + 1;
    while (j < lines.length && (lines[j].blank || lines[j].continued || lines[j].indent > line.indent)) j++;
    spans.push([line.start, startOf(j)]);
  });
  for (const lambda of code.matchAll(/\blambda\b/g)) {
    let j = 0;
    while (j < lines.length && lines[j].start <= lambda.index) j++;
    while (j < lines.length && lines[j].continued) j++;
    spans.push([lambda.index, startOf(j)]);
  }
  return (offset) => spans.some(([from, to]) => offset >= from && offset < to);
}

/**
 * A script's code, with each comment and string literal blanked to spaces
 * (its newlines kept, so offsets hold), and each literal's text with the
 * offsets of its opening quote and just past its close. A literal may be
 * triple-quoted and take any prefix (r, b, f, u), and a backslash keeps the
 * character after it inside the literal, raw or not, as Python reads it. An
 * f-string's replacement fields are read as its text. A literal in single
 * quotes that reaches the end of its line ends there, so a stray quote can't
 * take the rest of the script.
 */
function readScript(script: string): { code: string; strings: { text: string; start: number; end: number }[] } {
  const strings: { text: string; start: number; end: number }[] = [];
  let code = '';
  let at = 0;
  const special = /[#'"]/g;
  for (let found = special.exec(script); found; found = special.exec(script)) {
    const start = found.index;
    let end: number;
    if (found[0] === '#') {
      const lineEnd = script.indexOf('\n', start);
      end = lineEnd === -1 ? script.length : lineEnd;
    } else {
      const quote = script.startsWith(found[0].repeat(3), start) ? found[0].repeat(3) : found[0];
      let close = start + quote.length;
      while (close < script.length && !script.startsWith(quote, close) && (quote.length === 3 || script[close] !== '\n')) {
        close += script[close] === '\\' ? 2 : 1;
      }
      close = Math.min(close, script.length);
      end = script.startsWith(quote, close) ? close + quote.length : close;
      strings.push({ text: script.slice(start + quote.length, close), start, end });
    }
    code += script.slice(at, start) + script.slice(start, end).replace(/[^\n]/g, ' ');
    at = special.lastIndex = end;
  }
  return { code: code + script.slice(at), strings };
}
