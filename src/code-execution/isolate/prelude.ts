/**
 * The guest's prelude: JavaScript the engine evaluates before a script, which
 * builds what a script meets from the binding's two globals, `__host(name,
 * argsJson)` and `__output(stream, text)`:
 *
 * - `tools[name](args)`, each tool by its exact name, answering one result
 *   shape, `{ content, structuredContent, isError }`. A refusal before
 *   dispatch rejects with an Error carrying the refusal's fields. Reading a
 *   name that isn't a tool throws at once, naming the close matches.
 *   At most MAX_CALLS_IN_FLIGHT are out at once, and one past them waits
 *   here, in the script's own memory, until one is answered.
 * - `ALL_TOOLS`, each tool's name, description and input schema.
 * - `text(value)` and `console.log/info/warn/error/debug(...)`, which write
 *   the script's output: a string as it is, anything else as JSON.
 * - `wake_agent(payload)`, which asks the host to wake the agent.
 * - `__run(src)`, which runs a script as the body of an async function, so it
 *   may `await` at its top level and `return` a value.
 *
 * Nothing here guards a boundary: the guest's whole world is this instance,
 * and every call it makes is checked by the host. Built-ins aren't frozen, so a
 * script that patches one breaks only itself: its calls and its ending are
 * recorded outside the guest.
 *
 * Adapted from pi-codemode's guest prelude (`@earendil-works/pi-codemode`
 * 1.3.0, `dist/runtime/prelude-source.js`): the tools proxy and its
 * close-match error, the output helpers and the error formatting. Its licence,
 * the LICENSE at the root of github.com/earendil-works/pi, which the package's
 * `license: "MIT"` refers to:
 *
 * MIT License. Copyright (c) 2025 Mario Zechner. Permission is hereby granted,
 * free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions
 * of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { MAX_CALLS_IN_FLIGHT } from './protocol.js';
import { cutOf } from './render.js';

/** The host call name `wake_agent()` uses. Parentheses can't be in a tool's name, so it never names a tool. */
export const WAKE_CALL_NAME = '(wake_agent)';

/**
 * How many lines QuickJS's async function constructor puts before a script's
 * first line, and the filename it gives the script's code: a script's frames
 * read `<input>:N:C`, with its own line N less this.
 */
export const SCRIPT_LINE_OFFSET = 2;

/**
 * A frame of the script's own code, as QuickJS writes one in a stack: "    at
 * NAME (PLACE)", or "    at PLACE" for a syntax error, its PLACE at the end
 * and the script's, `<input>:LINE:COLUMN`, its LINE of at most ten digits, as
 * QuickJS writes a line (a 32-bit integer). A NAME may hold any character but
 * a line feed, which the stack's lines are split at, so `[^]` rather than
 * `.`, which stops at a carriage return and U+2028 and U+2029 too. The
 * guest's copy of the rule (errorText) is given these two patterns as they
 * are.
 */
export const SCRIPT_FRAME = /^\s+at\s[^]*<input>:\d{1,10}:\d+\)?$/;
/** A script frame's place, at its end: its line is renumbered as the agent wrote it. */
export const SCRIPT_PLACE = /<input>:(\d{1,10})(:\d+\)?)$/;
/**
 * SCRIPT_FRAME as it reads a line within a whole stack, from the line's
 * start (sticky) to the line feed or the stack's end that closes it, so that
 * no string is made for the line: a line holds no line feed, so there `\s`
 * is `[^\S\n]` and `[^]` is `[^\n]`. A test holds the two to one reading.
 */
const SCRIPT_FRAME_IN_STACK = /[^\S\n]+at[^\S\n][^\n]*<input>:\d{1,10}:\d+\)?(?=\n|$)/y;

/**
 * A failure's frames as the agent reads them, one per line: the script's own,
 * numbered as the agent wrote its lines, leaving out the prelude's frames and
 * the engine's native ones. QuickJS gives an Error's stack as its frames
 * alone, and nothing here adds the failure's name and message to it, so the
 * script's frames are the lines shaped as its frames are (SCRIPT_FRAME): a
 * line of a stack the script or its Error.prepareStackTrace set is one if it
 * is shaped so, and isn't otherwise. A function's name holding a line feed
 * splits its frame in two, and each half is read on its own, so the frame is
 * lost unless a half is itself shaped as a frame. Code the script compiles at
 * run time is named `<input>` as the script is, so the rule takes its frames
 * for the script's: an eval's read at its string's lines less two, and a
 * Function constructor's at its body's own lines, plus one for each line
 * break in its parameters, since the constructor puts its parameters and two
 * lines before the body, as the prelude's AsyncFunction does. The prelude's
 * errorText applies this rule in the guest, to an Error the script logs,
 * leading with the name and message, while a string the script logs, an
 * Error's `stack` among them, shows as QuickJS or the script wrote it; the
 * child applies the rule here to every failure's stack. The two are one rule:
 * the guest is given the pair of patterns as they are, and the walk here
 * reads SCRIPT_FRAME as SCRIPT_FRAME_IN_STACK and renumbers a place itself,
 * as SCRIPT_PLACE says, so a change to one has to be made to all three, and
 * tests hold them together.
 */
export function scriptFrames(stack: string, max = Infinity): string {
  // Two walks of the stack, a line at a time, making no string for a line
  // that isn't a frame, or for a frame the cut doesn't keep: a stack the
  // script set can be any length, as many lines as characters or one line as
  // long as the stack, and beside it the child holds only what the cut keeps.
  // The first walk measures the frames' text; the second takes what the cut
  // keeps of it, all of it if it fits `max`, or else its first and last
  // halves (bounded's cut, cutOf).
  let length = -1;
  eachFrame(stack, (start, place, line, rest, end) => {
    length += 1 + (place - start) + LABEL_CHARS + digits(line) + (end - rest);
  });
  if (length < 0) return '';
  const fits = length <= max;
  const half = fits ? length : Math.floor(max / 2);
  const tailFrom = length - (fits ? 0 : half);
  const head: string[] = [];
  const tail: string[] = [];
  let at = 0;
  // The part of the frames' text from `at` that `text` gives from `from` to
  // `to`: what of it falls in the head or the tail goes there.
  const put = (text: string, from: number, to: number): void => {
    const n = to - from;
    if (at < half) head.push(text.slice(from, from + Math.min(n, half - at)));
    if (at + n > tailFrom) tail.push(text.slice(from + Math.max(0, tailFrom - at), to));
    at += n;
  };
  eachFrame(stack, (start, place, line, rest, end) => {
    if (at > 0) put('\n', 0, 1);
    put(stack, start, place);
    const n = LABEL_CHARS + digits(line);
    if (at < half || at + n > tailFrom) put(`script:${line}`, 0, n);
    else at += n;
    put(stack, rest, end);
  });
  return fits ? head.join('') : cutOf(head.join(''), tail.join(''), length);
}

/** `script:`, which a frame's place is renumbered with. */
const LABEL_CHARS = 7;

/** How many digits a whole number from 1 to 9,999,999,999 is written with. */
function digits(n: number): number {
  let count = 1;
  for (let rest = n; rest >= 10; rest = Math.floor(rest / 10)) count += 1;
  return count;
}

/**
 * Each of the script's frames in `stack`, in order, as scriptFrames reads
 * them, with no string made for a line: where its line starts, where its
 * place starts, its place's line as the agent wrote it, where the rest of its
 * place starts (`:COLUMN`, and a closing parenthesis), and where its line
 * ends.
 */
function eachFrame(stack: string, frame: (start: number, place: number, line: number, rest: number, end: number) => void): void {
  for (let start = 0; start <= stack.length; ) {
    let end = stack.indexOf('\n', start);
    if (end === -1) end = stack.length;
    SCRIPT_FRAME_IN_STACK.lastIndex = start;
    if (SCRIPT_FRAME_IN_STACK.test(stack)) {
      // A frame ends in its place, and no later `<input>:` fits in what
      // follows it there. Its line has at most ten digits, so the number is
      // exact and digits() ends, as it wouldn't on the Infinity that a few
      // hundred digits parse to.
      const place = stack.lastIndexOf('<input>:', end);
      let line = 0;
      let rest = place + 8;
      for (let c = stack.charCodeAt(rest); c >= 48 && c <= 57; c = stack.charCodeAt(++rest)) line = line * 10 + (c - 48);
      frame(start, place, Math.max(1, line - SCRIPT_LINE_OFFSET), rest, end);
    }
    start = end + 1;
  }
}

/** One tool as the prelude lists it in ALL_TOOLS. */
export interface PreludeTool {
  name: string;
  description: string;
  /** The tool's input schema, as the agent's own tool list gives it. */
  inputSchema?: unknown;
}

/**
 * The prelude, for these tools. The child, not the prelude, refuses a wake
 * past the script's cap (child.ts). The tool list goes in as
 * a JSON string the prelude parses, so a schema's `__proto__` key stays a key,
 * as it would not in an object literal, and the prelude is one string the
 * engine evaluates as global code.
 */
export function preludeSource(tools: readonly PreludeTool[]): string {
  const toolsJson = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? null })));
  return `(function (host, out, toolList) {
  "use strict";
  const stringify = JSON.stringify;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const scriptOffset = ${SCRIPT_LINE_OFFSET};

  // QuickJS stacks list frames only: lead with "Name: message", as V8 does, and
  // keep only the script's own frames, leaving out this prelude's, the
  // engine's native ones and the line that started the script, each numbered
  // as the agent wrote its lines. The child applies the same rule to every
  // failure's stack (scriptFrames), reading each line in place.
  const scriptFrame = ${SCRIPT_FRAME};
  const scriptPlace = ${SCRIPT_PLACE};
  function errorText(error) {
    const head = error.message ? String(error.name) + ": " + String(error.message) : String(error.name);
    const stack = typeof error.stack === "string" ? error.stack : "";
    const frames = stack.split("\\n")
      .filter((line) => scriptFrame.test(line))
      .map((line) => line.replace(scriptPlace, (m, n, rest) => "script:" + Math.max(1, Number(n) - scriptOffset) + rest));
    return [head, ...frames].join("\\n");
  }

  function format(value) {
    if (typeof value === "string") return value;
    if (value instanceof ErrorCtor) return errorText(value);
    try {
      const json = stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  function write(stream, value) {
    let rendered;
    try {
      rendered = format(value);
    } catch (error) {
      throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
    }
    out(stream, rendered + "\\n");
  }

  // A refusal before dispatch arrives as its JSON, { name, message, ...fields }.
  function asError(reason) {
    if (reason instanceof ErrorCtor) return reason;
    const fields = reason !== null && typeof reason === "object" ? reason : { message: String(reason) };
    const error = new ErrorCtor(typeof fields.message === "string" ? fields.message : "the call was refused");
    for (const key of Object.keys(fields)) {
      if (key === "name" || key === "message" || key === "stack") continue;
      Object.defineProperty(error, key, { value: fields[key], writable: true, enumerable: true, configurable: true });
    }
    if (typeof fields.name === "string" && fields.name) error.name = fields.name;
    return error;
  }

  function toJson(name, args) {
    let json;
    try {
      json = stringify(args);
    } catch (error) {
      throw new TypeErrorCtor(name + "'s arguments aren't JSON (" + (error instanceof ErrorCtor ? error.message : String(error)) + "); nothing was sent");
    }
    if (json === undefined) throw new TypeErrorCtor(name + "'s arguments aren't JSON; nothing was sent");
    return json;
  }

  // At most maxInFlight of the script's tool calls are out at once. One past
  // them waits here, in the script's own memory, until one is answered, and
  // its place passes straight to it: never refused, only paced.
  const maxInFlight = ${MAX_CALLS_IN_FLIGHT};
  let inFlight = 0;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) next();
    else inFlight -= 1;
  }
  function call(name, args) {
    let json;
    try {
      json = args === undefined ? "{}" : toJson(name, args);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const go = () => {
        let pending;
        try {
          pending = host(name, json);
        } catch (error) {
          release();
          reject(asError(error));
          return;
        }
        pending.then(
          (value) => { release(); resolve(value); },
          (reason) => { release(); reject(asError(reason)); },
        );
      };
      if (inFlight < maxInFlight) {
        inFlight += 1;
        go();
      } else {
        waiting.push(go);
      }
    });
  }

  // wake_agent() takes no place among the calls in flight. The child refuses
  // a payload too large, and a wake past the script's cap, before any goes out.
  function wake(payload) {
    let json;
    try {
      json = toJson("wake_agent()", payload === undefined ? null : payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return host(${JSON.stringify(WAKE_CALL_NAME)}, json).then((value) => value, (reason) => { throw asError(reason); });
  }

  const tools = Object.create(null);
  const allTools = [];
  for (const { name, description, inputSchema } of toolList) {
    if (name in tools) continue;
    tools[name] = (args) => call(name, args);
    allTools.push(Object.freeze({ name, description, inputSchema }));
  }
  Object.freeze(tools);
  Object.freeze(allTools);

  // A name that isn't a tool throws at once, naming the close matches, rather
  // than failing later as "not a function". \`in\` still answers false.
  const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = allTools.map((tool) => tool.name);
  const toolsProxy = new Proxy(tools, {
    get(object, property, receiver) {
      if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
        return Reflect.get(object, property, receiver);
      }
      const wanted = comparable(property);
      const exact = names.filter((name) => comparable(name) === wanted);
      const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
      let message = "tools[" + stringify(property) + "] is not one of your tools.";
      if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => "tools[" + stringify(name) + "]").join(", ") + "?";
      else if (names.length === 0) message += " You have no tools.";
      else if (names.length <= 20) message += " Your tools: " + names.join(", ") + ".";
      else message += " ALL_TOOLS lists them.";
      message += " Nothing was sent.";
      throw new TypeErrorCtor(message);
    },
  });

  const consoleObject = {};
  for (const level of ["log", "info", "debug"]) consoleObject[level] = (...args) => out(1, args.map(format).join(" ") + "\\n");
  for (const level of ["warn", "error"]) consoleObject[level] = (...args) => out(2, args.map(format).join(" ") + "\\n");
  Object.freeze(consoleObject);

  const AsyncFunction = (async function () {}).constructor;
  // The script's value, as the JSON text of what it returned, serialized here
  // once: its toJSON and getters run once, and the engine serializes this text
  // as a string, which runs no script code however often it's read. A value
  // JSON can't hold, such as a function, a cycle or a BigInt, is its string form.
  async function run(src) {
    let value;
    try {
      const fn = new AsyncFunction(src);
      value = await fn.call(undefined);
    } catch (error) {
      // An Error goes as it is, a syntax error's included: the child puts its
      // frames as the agent reads them (scriptFrames). Anything else thrown,
      // such as a plain object or a string, fails the script with its JSON or
      // its string form as the message, so the agent reads what was thrown;
      // its stack, made here, holds no frame of the script's.
      if (error instanceof ErrorCtor) throw error;
      const failure = new ErrorCtor(format(error));
      failure.name = "";
      throw failure;
    }
    if (value === undefined) return undefined;
    let json;
    try {
      json = stringify(value);
    } catch {
      json = undefined;
    }
    if (json !== undefined) return json;
    // Said as a string, so the agent reads that the value itself didn't come back.
    let text;
    try {
      text = "JSON can't hold the returned value, so this is its string form: " + String(value);
    } catch {
      text = "JSON can't hold the returned value, and it has no string form";
    }
    return stringify(text);
  }

  Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
  Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
  Object.defineProperty(globalThis, "console", { value: consoleObject, enumerable: true, configurable: true });
  Object.defineProperty(globalThis, "text", { value: (value) => write(1, value), enumerable: true });
  Object.defineProperty(globalThis, "wake_agent", { value: wake, enumerable: true });
  Object.defineProperty(globalThis, "__run", { value: run });
  try { delete globalThis.__host; delete globalThis.__output; } catch {}
})(globalThis.__host, globalThis.__output, JSON.parse(${JSON.stringify(toolsJson)}));
`;
}

/** The one line `start` evaluates after the prelude: the script, as a string literal, handed to `__run`. */
export function scriptCall(script: string): string {
  return `await __run(${JSON.stringify(script)});`;
}
