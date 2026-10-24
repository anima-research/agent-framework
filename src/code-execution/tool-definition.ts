/**
 * `code_execution`: its configuration, the check that refuses one that still
 * sets what the Python runner took, and the tool's definition, the text an
 * agent reads before it writes a script. It follows the surface of Code Mode
 * tools elsewhere (exact names, one result shape, top-level await), and says
 * each rule once.
 */

import type { CodeExecutionConfig, ToolDefinition } from '../types/index.js';
import { assertBooleanSetting, holdsSettings } from '../config-checks.js';
import { MAX_MEMORY_BYTES, MAX_RESULT_DEPTH, MIN_MEMORY_BYTES } from './engine.js';
import { DEFAULT_OUTPUT_BOUNDS } from './isolate/output.js';
import { MAX_ARGUMENT_BYTES, MAX_ARGUMENT_VALUES, MAX_CALLS_IN_FLIGHT, MAX_WAKE_PAYLOAD_BYTES } from './isolate/protocol.js';
import { formatMs, VALUE_CHARS } from './isolate/render.js';

const PAGE_BYTES = 64 * 1024;

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

/** The isolate's settings. Each has a default. */
export interface IsolateSettings {
  /** The bound a run or wait yields at, unless the agent asks otherwise. */
  yieldMs: number;
  /** The most an agent may ask for. */
  maxYieldMs: number;
  /** A script's limit: there it's stopped. */
  scriptLifetimeMs: number;
  /** Scripts one agent may have running at once, yielded ones included. */
  maxRunningScripts: number;
  /** Script children a host runs at once. */
  maxScriptChildren: number;
  /** How long a call may go unanswered before the script is told it timed out. */
  toolCallTimeoutMs: number;
  wakeMinIntervalMs: number;
  maxWakesPerScript: number;
  /**
   * The WebAssembly memory's maximum for each script: its budget, a whole
   * number of 64 KiB pages from 4 MiB to 2 GiB. A child stays within about its
   * runtime's base plus 2.7 times this: the linear memory itself, and a result
   * in transit, which takes two to five times its size and is refused past a
   * third of this. Beside that come the script's calls as they go out, held
   * while a result settles or not: at most 16 at once, the calls the prelude
   * lets out, each with at most 4 MiB of JSON arguments, which the child holds
   * as text and encodes, up to about 200 MiB under Node and 410 MiB under
   * Bun. Measured on the child under Node 24.22.0 and Bun 1.4.3, whose base
   * was about 85 and 55 MiB, at budgets from 32 MiB to 1 GiB.
   *
   * The host holds, for each script, the calls it has out and their answers:
   * at most 16 calls out in the host at once, timed-out ones whose tools still
   * run included, each with at most 4 MiB of JSON arguments holding 100,000
   * values (about 25 MiB as text and parsed, by a probe of the costliest
   * shapes under Node 24 and Bun 1.4), up to 16 more waiting for those as
   * their text (at most 8 MiB each), up to 16 answers until the child takes
   * them, each at most a third of this as its frame, and the one being
   * encoded also as its JSON text (up to twice its bytes), the frame from the
   * child being read (at most 25 MiB, and its text and its parse up to twice
   * that each, since a string can take two bytes a character: 125 MiB), and
   * its waiting wakes, at most 64 KiB of JSON each, up to 128 KiB as text.
   * That's at most about 6 times this, plus 653 MiB,
   * plus 128 KiB for each wake maxWakesPerScript allows: about 1.4 GiB a
   * script at the defaults. A tool's
   * own result, and the one serialization the bridge makes of it to check its
   * size, are the tool's, outside this. Size a host by that and by the
   * child's own memory.
   *
   * A result is sent only if it's at most a third of this; within that, what
   * fits the script depends on its shape, since parsing builds it in this
   * memory: at 128 MiB, a string or an array of numbers up to that third fits,
   * and an array of small objects up to about 24 MiB, by a probe of each
   * shape. A result that doesn't fit reaches the script as ResultTooLarge,
   * which says the call took effect.
   */
  memoryMaxBytes: number;
}

export const DEFAULT_SETTINGS: IsolateSettings = {
  yieldMs: 30_000,
  maxYieldMs: 600_000,
  scriptLifetimeMs: 86_400_000,
  maxRunningScripts: 3,
  maxScriptChildren: 16,
  toolCallTimeoutMs: 270_000,
  wakeMinIntervalMs: 60_000,
  maxWakesPerScript: 100,
  memoryMaxBytes: 128 * 1024 * 1024,
};

/** What the Python runner took that the isolate doesn't, and what to set instead. */
const RETIRED: Record<string, string> = {
  pythonPath: 'scripts are JavaScript now, run by an engine built into agent-framework, so there is no interpreter to name; leave it out',
  idleReclaimMs: 'each script starts fresh and keeps nothing after it ends, so there is nothing to reclaim; leave it out',
  env: "a script's world holds only your agent's tools, with no environment; leave it out",
  inheritEnv: "a script's world holds only your agent's tools, with no environment; leave it out",
  scriptTimeoutMs: 'a script now yields at its bound and keeps running: set yieldMs for the bound',
  maxScriptTimeoutMs: 'set maxYieldMs, the most an agent may ask a run or a wait to wait',
  backgroundMaxLifetimeMs: "every script now has one limit: set scriptLifetimeMs",
  maxBackgroundScripts: 'set maxRunningScripts, how many scripts an agent may have running at once, yielded ones included',
};

const MS_KEYS = ['yieldMs', 'maxYieldMs', 'scriptLifetimeMs', 'toolCallTimeoutMs', 'wakeMinIntervalMs'] as const;
const COUNT_KEYS = ['maxRunningScripts', 'maxScriptChildren', 'maxWakesPerScript', 'memoryMaxBytes'] as const;
/** Node's timer range: a timer longer than this fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The isolate's settings from a `codeExecution` configuration that's on, with each
 * default filled in. Throws, naming the key and what to do, for a key the
 * Python runner took, or a value that isn't a whole number in range.
 */
export function isolateSettings(cfg: Record<string, unknown>): IsolateSettings {
  for (const [key, why] of Object.entries(RETIRED)) {
    if (cfg[key] !== undefined && cfg[key] !== null) throw new Error(`codeExecution.${key} is no longer read: ${why}`);
  }
  const out: IsolateSettings = { ...DEFAULT_SETTINGS };
  for (const key of [...MS_KEYS, ...COUNT_KEYS]) {
    const value = cfg[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`codeExecution.${key} must be a whole number of ${MS_KEYS.includes(key as never) ? 'milliseconds' : 'units'} of 0 or more`);
    }
    if (MS_KEYS.includes(key as never) && value > MAX_TIMER_MS) {
      throw new Error(`codeExecution.${key} must be at most ${MAX_TIMER_MS} ms, the longest a timer can wait`);
    }
    (out as unknown as Record<string, number>)[key] = value;
  }
  if (out.maxYieldMs < out.yieldMs) {
    throw new Error(`codeExecution.maxYieldMs (${out.maxYieldMs}) must be at least yieldMs (${out.yieldMs}): the default is always allowed`);
  }
  if (out.maxRunningScripts < 1 || out.maxScriptChildren < 1) {
    throw new Error('codeExecution.maxRunningScripts and maxScriptChildren must each be at least 1');
  }
  if (out.memoryMaxBytes % PAGE_BYTES !== 0 || out.memoryMaxBytes < MIN_MEMORY_BYTES || out.memoryMaxBytes > MAX_MEMORY_BYTES) {
    throw new Error(
      `codeExecution.memoryMaxBytes must be a whole number of 64 KiB pages from ${MIN_MEMORY_BYTES} (4 MiB) to ${MAX_MEMORY_BYTES} (2 GiB), not ${out.memoryMaxBytes}`,
    );
  }
  return out;
}

function formatBytes(bytes: number): string {
  const MiB = 1024 * 1024;
  if (bytes % (1024 * MiB) === 0) return `${bytes / (1024 * MiB)} GiB`;
  if (bytes % MiB === 0) return `${bytes / MiB} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/**
 * The `code_execution` tool as an agent is offered it under these settings,
 * the `codeExecution` that `create()` takes (each left out has its default).
 * A setting the Python runner took is refused by name, as `create()` refuses it.
 */
export function buildCodeExecutionToolDefinition(config: Partial<CodeExecutionConfig> = {}): ToolDefinition {
  return describeCodeExecution(isolateSettings(config as unknown as Record<string, unknown>));
}

/** The tool's definition under settings already resolved. */
export function describeCodeExecution(s: IsolateSettings): ToolDefinition {
  const { headChars, tailChars } = DEFAULT_OUTPUT_BOUNDS;
  const chars = (n: number) => n.toLocaleString('en-US');
  return {
    name: CODE_EXECUTION_TOOL_NAME,
    description:
      'Run JavaScript that calls your other tools, so that many calls, and the results between them, happen in one step and stay out of your context. ' +
      'The script is the body of an async function: await at its top level, and return a value to see it. ' +
      `The value comes back as JSON, and past ${chars(VALUE_CHARS)} characters as its first and last ${chars(VALUE_CHARS / 2)}. It's made in the script's memory, so a large one needs room there for its text twice over. ` +
      'Call a tool by its exact name, as ALL_TOOLS gives it: await tools["module--tool"]({ ...its arguments }). ' +
      'Every tool answers one shape, { content, structuredContent, isError }: content is a list of blocks, what you would have read, most often one { type: "text", text }; ' +
      "structuredContent is the tool's data as a value, when it gives one beside that text, otherwise null; and isError is true when the tool failed, its text saying why. " +
      'With no structuredContent, the answer is in content, most often its text: JSON.parse(result.content[0].text) reads one given as JSON. ' +
      'A tool that turns a call down itself, such as for a missing argument, answers this way, with isError. ' +
      "A call that can't go out (the tool isn't yours now, or its arguments aren't an object) doesn't answer: its await throws a ToolRefused error, and nothing is sent for it. " +
      'A Promise.all holding it rejects with that error, while the calls beside it still go out. ' +
      `A call's arguments may be up to ${formatBytes(MAX_ARGUMENT_BYTES)} of JSON with at most ${chars(MAX_ARGUMENT_VALUES)} values: ` +
      'a generated file of a few MB of ordinary text fits as one string (quotes, backslashes and control characters take more room once escaped), and more goes in parts, over several calls. ' +
      `ALL_TOOLS lists your tools, each with its name, description and inputSchema. Run independent calls together with Promise.all: up to ${MAX_CALLS_IN_FLIGHT} are out at once, and the rest wait their turn. ` +
      `A call out that gets no answer within ${formatMs(s.toolCallTimeoutMs)} throws a TimeoutError that says whether it was sent: one never sent did nothing, but one sent may still take effect, so a retry may do it twice. ` +
      'Write output with text(value) or console.log(...): only what the script writes and returns comes back to you, with how it ended and what became of its calls, ' +
      'so filter large results in the script. ' +
      'Each script starts fresh and keeps nothing after it ends: write what must last with a tool. ' +
      'A script reaches nothing but your tools: no network, files, timers or packages. ' +
      `A script has ${formatBytes(s.memoryMaxBytes)} of memory. A result too large for it, or nested more than ${chars(MAX_RESULT_DEPTH)} deep, doesn't reach the script: the call's ResultTooLarge error says the tool ran. ` +
      `A run or a wait takes yield_time_ms, how long to wait for the script (default ${formatMs(s.yieldMs)}, at most ${formatMs(s.maxYieldMs)}). ` +
      'If the script is still running then, you get what it has written, and it keeps running: ' +
      '{"action": "wait", "script_id": ...} waits again, {"action": "stop", "script_id": ...} stops it, and {"action": "list"} lists your scripts. ' +
      `Each return shows what the script wrote since the previous one: its first ${chars(headChars)} and last ${chars(tailChars)} characters, with a count of what was dropped between them. ` +
      "A return longer than your inline cap for tool results (tool_result_inline_max_chars in agent_settings) has its output's first and last parts cut alike to fit; " +
      "if the rest of the return leaves the output no room, the return is cut there as any long tool result is, keeping its start. " +
      "You may leave a script running past your turn, unless the host names another agent as its primary agent, whose scripts alone outlive a turn: " +
      'a yield says when yours will be stopped at your turn\'s end. ' +
      `A script left running can wake you with await wake_agent(payload), a payload of at most ${formatBytes(MAX_WAKE_PAYLOAD_BYTES)} of JSON, ` +
      `and you are woken if it fails, crashes or reaches its limit of ${formatMs(s.scriptLifetimeMs)}; a clean finish waits for your wait or list. ` +
      'A script whose body returns while its calls are still running waits for them, and for the calls its pending work goes on to make: ' +
      "it's still running until they're done. " +
      'When a script ends, the result says how, what became of its calls (any still running when it was stopped may or may not have taken effect), ' +
      `what it returned, and its output. You may have ${s.maxRunningScripts} scripts running at once.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'JavaScript to run, as the body of an async function.' },
        action: {
          type: 'string',
          enum: ['run', 'wait', 'stop', 'list'],
          description: 'run (default) runs code; wait and stop take a script_id; list shows your scripts.',
        },
        script_id: { type: 'string', description: 'The script to wait for or stop.' },
        yield_time_ms: {
          type: 'integer',
          description: `For a run or a wait: how long to wait for the script, in milliseconds, before it yields. Default ${s.yieldMs}, at most ${s.maxYieldMs}.`,
        },
      },
      required: [],
    },
  };
}

/** The first Bun a script's process runs on reliably. */
export const MIN_BUN_VERSION = '1.4.0';

/**
 * Why code execution can't run on this Bun, or null when it can (and under
 * Node, where `bun` is undefined). Bun 1.3.14 loses a child's fd 3, the pipe a
 * script's process answers on, at some starts: in a probe, 30 of 200 children
 * started one at a time lost it before their first write, where under Bun
 * 1.4.0 through 1.4.3, and Node 24, none of 200 did.
 */
export function bunVersionProblem(bun: string | null): string | null {
  if (bun === null) return null;
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [have, need] = [parts(bun), parts(MIN_BUN_VERSION)];
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return null;
    if (have[i]! < need[i]!) {
      return `codeExecution needs Bun ${MIN_BUN_VERSION} or later, and this host runs Bun ${bun}, ` +
        "which at some starts loses the pipe a script's process answers on, crashing the script: " +
        `move the host to Bun ${MIN_BUN_VERSION} or later, or run it on Node`;
    }
  }
  // The floor's own version, as a prerelease (1.4.0-canary.1), comes before it,
  // and no such build was checked.
  return /^\d+\.\d+\.\d+-/.test(bun)
    ? `codeExecution needs Bun ${MIN_BUN_VERSION} or later, and this host runs Bun ${bun}, a build from before ${MIN_BUN_VERSION}'s release, ` +
      `which hasn't been checked with it: move the host to Bun ${MIN_BUN_VERSION} or later, or run it on Node`
    : null;
}

/**
 * Refuse a codeExecution that isn't an object, or whose switch is set to
 * anything but true or false, and, once it's on, one that sets what the
 * Python runner took or a value out of range (isolateSettings), or that a Bun
 * too old to run it would run (bunVersionProblem). A JSON config,
 * or a `${VAR}` substituted as a string, can carry a quoted "false" where the
 * type says boolean, and only `true` turns code execution on, so the quotes
 * would hide what the value does. A null or false codeExecution counts as not
 * set, as a left-out one does. A configuration that isn't on has nothing else
 * read.
 */
/** `bun` is the Bun this runs on, null under Node: the running one's when left out. */
export function validateCodeExecutionConfig(cfg: unknown, bun: string | null = process.versions.bun ?? null): void {
  if (!holdsSettings('codeExecution', cfg, '{ enabled: true }')) return;
  const settings = cfg as Record<string, unknown>;
  assertBooleanSetting(
    'codeExecution.enabled',
    settings.enabled,
    "true gives agents the code_execution tool, which runs their scripts in a JavaScript engine of the host's, " +
      "and false or leaving it out doesn't",
  );
  if (settings.enabled !== true) return;
  isolateSettings(settings);
  const problem = bunVersionProblem(bun);
  if (problem) throw new Error(problem);
}
