/**
 * Synthesized `code_execution` tool definition.
 *
 * The name, input shape ({code}), and description framing deliberately track
 * Anthropic's server-side programmatic tool calling so models' trained
 * priors transfer: python scripts, tools as async functions taking a single
 * dict and returning a string, stdout as the return channel, persistent
 * interpreter state, asyncio.gather for fan-out.
 */

import type { ToolDefinition } from '../types/index.js';
import { assertBooleanSetting, holdsSettings, kindOf } from '../config-checks.js';
import { formatLimit, MAX_TIMER_MS } from './py-runner.js';

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

export function buildCodeExecutionToolDefinition(opts?: {
  idleReclaimMs?: number;
  toolCallTimeoutMs?: number;
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  backgroundMaxLifetimeMs?: number;
}): ToolDefinition {
  const idleMinutes = Math.max(1, Math.round((opts?.idleReclaimMs ?? 300_000) / 60_000));
  const callTimeoutSeconds = Math.round((opts?.toolCallTimeoutMs ?? 270_000) / 1000);
  const limits = scriptTimeLimits(opts);
  return {
    name: CODE_EXECUTION_TOOL_NAME,
    description:
      'Run Python code that can call your other tools programmatically. ' +
      'Every tool you have is available inside the script as an async Python function: ' +
      "the function name is the tool name with '--' replaced by '__' and any other " +
      "non-identifier character replaced by '_' " +
      "(e.g. tool 'mcpl--discord--fetch_history' is the function mcpl__discord__fetch_history, " +
      "and tool 'mcpl--dog-events--status' is mcpl__dog_events__status). " +
      'Each function takes a single dict of arguments and returns a string: the text the tool ' +
      'would have returned to you directly, or "Error: ..." if the call failed. For a result ' +
      'with structured content, the string is a JSON object to parse with json.loads: ' +
      '{"content": [...], "structuredContent": ..., "isError": false}, with "error" added when ' +
      `"isError" is true. "content" holds the server's content blocks. A reference to a payload ` +
      'appears there as {"type": ..., "refId": ..., "savedTo": ...}, where "savedTo" is the ' +
      `workspace path the payload was saved to (null if it wasn't) and "refId" is fetch_reference's ` +
      'ref_id. A structured result over 5 MB is saved to the workspace instead, and the string is ' +
      '{"isError": ..., "oversized": {"chars": ..., "savedTo": ...}}. ' +
      'Each string also carries .is_error (True if the result is an error, else False; test it ' +
      'rather than an "Error:" prefix) and .structured (the parsed "structuredContent" of the ' +
      'JSON object above, or None). ' +
      "An exact-name lookup dict is also available: tools['mcpl--discord--fetch_history']({...}). " +
      'Use top-level await; run independent calls in parallel with asyncio.gather. ' +
      'Only how the script ended, what it and the commands it runs print (stdout and stderr), and a line naming ' +
      'the tool calls that timed out or were cancelled in it, or were still running when it ended, come back to you; ' +
      'other tool results stay in the script, so filter or aggregate large data there and print only what you need. ' +
      'Interpreter state (variables, imports) persists ' +
      `across code_execution calls but is reclaimed after ~${idleMinutes} minutes idle. Relative paths resolve in a ` +
      'scratch directory of the interpreter\'s, which goes whenever it stops or is reclaimed, so a file meant to ' +
      'outlast the interpreter needs an absolute path. A tool call that receives no ' +
      `response within ~${callTimeoutSeconds}s raises TimeoutError inside the script, though the call was sent and may still take effect. ` +
      `A foreground script is stopped after ${formatLimit(limits.defaultMs)}; pass time_limit_ms to set this call's limit ` +
      `(at most ${formatLimit(limits.maxMs)}; a background script runs up to ${formatLimit(limits.backgroundMaxMs)}). ` +
      'Stopping a script does not stop tools it already called. ' +
      'Use this when fanning out across many items, looping over tool calls, or when tool ' +
      'results are large and you only need a slice or summary. Call tools directly (not via ' +
      'code) when a single call answers the question or when you need to reason about each ' +
      'result before deciding the next step. ' +
      'BACKGROUND MODE: pass background=true to run the script as a detached watcher that ' +
      'outlives this turn — the tool returns immediately with a script_id and you can end ' +
      'your turn (e.g. sleep). Inside a background script, await wake_agent(payload) wakes ' +
      'you: the payload plus provenance (script id, the line number in your script, elapsed ' +
      'time) is delivered into your context and starts a turn for you. A script that ends ' +
      'without calling wake_agent wakes nobody — that silence is the point (poll cheaply, ' +
      'wake only on signal). If your background script CRASHES you are woken with the error. ' +
      'If you have a writable workspace, its output streams to a log file there that you can read any time. Wakes are ' +
      'rate-limited (early wakes are delayed, not dropped) and capped per script. ' +
      'CAUTION: background scripts die silently if the host process restarts — for a wake ' +
      'you absolutely must not miss, also arm a wake rule as backup. ' +
      'Manage your scripts with {"action": "list"} and {"action": "cancel", "script_id": "..."}.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Top-level await is allowed.',
        },
        background: {
          type: 'boolean',
          description: 'Run detached as a background watcher with wake_agent() available (default false).',
        },
        action: {
          type: 'string',
          enum: ['run', 'list', 'cancel'],
          description: 'run (default) executes `code`; list shows your background scripts; cancel stops one.',
        },
        script_id: {
          type: 'string',
          description: 'Background script id (for action: cancel).',
        },
        time_limit_ms: {
          type: 'integer',
          description:
            `Time limit for this script in milliseconds; it is stopped when the limit is reached. ` +
            `Default ${limits.defaultMs}, at most ${limits.maxMs}; a background script defaults to and is capped at ` +
            `its ${formatLimit(limits.backgroundMaxMs)} lifetime.`,
        },
      },
      required: [],
    },
  };
}

/**
 * A script's time limits: the default, the most an agent may ask for with
 * `time_limit_ms`, and the background lifetime (default and ceiling at once).
 */
export function scriptTimeLimits(opts?: {
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  backgroundMaxLifetimeMs?: number;
}): { defaultMs: number; maxMs: number; backgroundMaxMs: number } {
  // Every limit fits Node's timer range (MAX_TIMER_MS, ~24.8 days).
  const defaultMs = Math.min(MAX_TIMER_MS, opts?.scriptTimeoutMs ?? 600_000);
  return {
    defaultMs,
    // A ceiling below the default is refused when a framework with code
    // execution on is created (validateCodeExecutionConfig); never below the
    // default here either.
    maxMs: Math.min(MAX_TIMER_MS, Math.max(defaultMs, opts?.maxScriptTimeoutMs ?? defaultMs)),
    backgroundMaxMs: Math.min(MAX_TIMER_MS, opts?.backgroundMaxLifetimeMs ?? 86_400_000),
  };
}

/**
 * Refuse a codeExecution that isn't an object, or whose switch is set to
 * anything but true or false, and, once it's on, one whose time limits
 * contradict each other or whose interpreter environment would be misread. A
 * JSON config, or a `${VAR}` substituted as a string, can carry a quoted
 * "false" where the type says boolean, and only `true` turns code execution
 * on, so the quotes would hide what the value does; a bare
 * `codeExecution: true` would be read as off. Likewise the runner passes the
 * host's environment only for an `inheritEnv` of `true`, so a quoted "true"
 * would quietly keep the allowlist. A null or false codeExecution, and a null
 * setting, count as not set, as left-out ones do. The refusal names the
 * value's kind, not the value. A configuration that isn't on has nothing else
 * read.
 */
export function validateCodeExecutionConfig(cfg: {
  enabled?: unknown;
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  env?: unknown;
  inheritEnv?: unknown;
}): void {
  if (!holdsSettings('codeExecution', cfg, '{ enabled: true }')) return;
  assertBooleanSetting(
    'codeExecution.enabled',
    cfg.enabled,
    'true gives agents the code_execution tool, which runs their scripts in a python interpreter on the host, ' +
      'and false or leaving it out doesn\'t',
  );
  if (cfg.enabled !== true) return;
  const defaultMs = cfg.scriptTimeoutMs ?? 600_000;
  if (cfg.maxScriptTimeoutMs !== undefined && !(cfg.maxScriptTimeoutMs >= defaultMs)) {
    throw new Error(
      `codeExecution.maxScriptTimeoutMs (${cfg.maxScriptTimeoutMs}) must be at least scriptTimeoutMs (${defaultMs}): ` +
        'it is the most an agent may ask for, and the default is always allowed',
    );
  }
  // None of the environment's refusals below shows the value it refuses,
  // at most its kind: a substituted value can be a credential. null counts
  // as not set, so a generated config that writes an unset setting as null
  // keeps working.
  assertBooleanSetting(
    'codeExecution.inheritEnv',
    cfg.inheritEnv,
    "true hands the interpreter the host's whole environment, and false or leaving it out keeps the allowlist",
  );
  if (cfg.env !== undefined && cfg.env !== null) {
    if (!isPlainObject(cfg.env)) {
      throw new Error(`codeExecution.env must be an object of variable names and string values, not ${kindOf(cfg.env)}`);
    }
    for (const [name, value] of Object.entries(cfg.env)) {
      // spawn writes each variable as name=value: a name that is empty or
      // holds '=' doesn't reach the interpreter as written, and a NUL in a
      // name or a value makes spawn throw at every start.
      // Only what comes before an '=' or NUL is shown: what follows can be a
      // value pasted into the name.
      if (name === '' || name.includes('=') || name.includes('\0')) {
        const shown = name === '' ? 'that is empty' : `starting ${JSON.stringify(name.split(/[=\0]/, 1)[0])} that holds '=' or NUL`;
        throw new Error(`codeExecution.env has a variable name ${shown}, and a name can't be empty or hold '=' or NUL`);
      }
      if (typeof value !== 'string') {
        throw new Error(`codeExecution.env.${name} must be a string, not ${kindOf(value)}: give its value as a string, or leave ${name} out`);
      }
      if (value.includes('\0')) {
        throw new Error(`codeExecution.env.${name} holds a NUL character, which no environment variable can carry`);
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
