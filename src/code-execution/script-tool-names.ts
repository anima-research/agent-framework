/**
 * Which of some tools a code_execution script names, read as Python reads
 * it, and which of them it leaves reachable by a later script in the same
 * interpreter. The framework holds a script's round for the names it
 * returns, and marks the agent's interpreter with the reachable ones
 * (AgentFramework.scriptMayRoute).
 *
 * A script reaches a tool through a function named for it (the tool's name,
 * after any prefix joined with `__`) or a `tools[...]` key. So a name counts
 * in code where Python could call it: after a character that can't continue
 * an identifier, or after `__`, and before a character that can't continue
 * one. `say_hello` and `my_say` don't name `say`; `mcpl__world__say(` does.
 * A comment names nothing, since Python never runs one. A name anywhere in a
 * string counts, since a string can be a key or code passed to eval or exec.
 *
 * A script leaves a tool reachable when its code names the tool other than
 * in a direct call (an alias, a reference) or defines a function, lambda or
 * class, or when one of its strings is the tool's whole name, as a key is,
 * and isn't called at once, as `tools["world--say"](…)` is. A direct call
 * finishes inside its own script. A string that only mentions a tool, as a
 * printed sentence does, leaves nothing reachable.
 *
 * Some reaches go unseen, such as a tool name the code doesn't spell out
 * (built at runtime, or written with escapes), code loaded from a file or
 * module, an enumeration of the tools, a call a script makes but awaits only
 * in a later one, and code a later script runs from a string an earlier one
 * kept.
 *
 * @param tools plain tool names, of identifier characters
 */
export function scriptToolNames(script: string, tools: readonly string[]): { names: Set<string>; reachable: Set<string> } {
  const named = new RegExp(`(?:(?<![A-Za-z0-9_])|(?<=__))(${tools.join('|')})(?![A-Za-z0-9_])`, 'g');
  const key = new RegExp(`^(?:.*(?:--|__))?(${tools.join('|')})$`);
  const { code, strings } = readScript(script);
  const names = new Set<string>();
  // Named in code, or by a string that is the whole name.
  const callable = new Set<string>();
  let referenced = false;
  for (const match of code.matchAll(named)) {
    callable.add(match[1]);
    CALLED.lastIndex = match.index + match[0].length;
    if (!CALLED.test(code)) referenced = true;
  }
  for (const { text, end } of strings) {
    const whole = key.exec(text);
    if (whole) {
      callable.add(whole[1]);
      KEY_CALLED.lastIndex = end;
      if (!KEY_CALLED.test(code)) referenced = true;
    }
    for (const match of text.matchAll(named)) names.add(match[1]);
  }
  for (const name of callable) names.add(name);
  const leavesReachable = callable.size > 0 && (referenced || /\b(?:def|lambda|class)\b/.test(code));
  return { names, reachable: leavesReachable ? callable : new Set() };
}

/** A direct call right after a name in code. */
const CALLED = /\s*\(/y;
/** A direct call right after a key, a `tools[...]` subscript's close and then `(`. */
const KEY_CALLED = /\s*\]\s*\(/y;

/**
 * A script's code, with each comment and string literal blanked to spaces
 * (its newlines kept, so offsets hold), and each literal's text and the
 * offset just past it. A literal may be triple-quoted and take any prefix
 * (r, b, f, u), and a backslash keeps the character after it inside the
 * literal, raw or not, as Python reads it. An f-string's replacement fields
 * are read as its text. A literal in single quotes that reaches the end of
 * its line ends there, so a stray quote can't take the rest of the script.
 */
function readScript(script: string): { code: string; strings: { text: string; end: number }[] } {
  const strings: { text: string; end: number }[] = [];
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
      strings.push({ text: script.slice(start + quote.length, close), end });
    }
    code += script.slice(at, start) + script.slice(start, end).replace(/[^\n]/g, ' ');
    at = special.lastIndex = end;
  }
  return { code: code + script.slice(at), strings };
}
