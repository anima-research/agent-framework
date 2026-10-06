/**
 * Synthesized `code_execution` tool definition.
 *
 * The name, input shape ({code}), and description framing deliberately track
 * Anthropic's server-side programmatic tool calling so models' trained
 * priors transfer: python scripts, tools as async functions taking a single
 * dict and returning a string, stdout as the return channel, persistent
 * interpreter state, asyncio.gather for fan-out.
 *
 * The execution lifecycle (wait_ms, on_timeout, action=wait) is additive: a
 * script that finishes within the observation budget behaves exactly as
 * before; one that doesn't returns a script_id and keeps running.
 */

import type { ToolDefinition } from '../types/index.js';
import { formatLimit, MAX_TIMER_MS } from './py-runner.js';

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

/** Bounds of the observation budget (`wait_ms`, `foregroundWaitMs`). */
export const MAX_WAIT_MS = 60_000;
export const DEFAULT_WAIT_MS = 10_000;

/** Unretrieved results announced by a completion notice, kept per agent. */
export const MAX_ANNOUNCED_RESULTS = 20;
/** Other settled results kept per agent (already retrieved, or never announced). */
export const MAX_RETAINED_RESULTS = 5;

export function buildCodeExecutionToolDefinition(opts?: {
  idleReclaimMs?: number;
  toolCallTimeoutMs?: number;
  foregroundWaitMs?: number;
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  backgroundMaxLifetimeMs?: number;
}): ToolDefinition {
  const idleReclaimMs = opts?.idleReclaimMs ?? 300_000;
  const idleMinutes = Math.max(1, Math.round(idleReclaimMs / 60_000));
  const callTimeoutSeconds = Math.round((opts?.toolCallTimeoutMs ?? 270_000) / 1000);
  const waitMs = opts?.foregroundWaitMs ?? DEFAULT_WAIT_MS;
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
      'Each function takes a single dict of arguments and returns a string — the same text ' +
      'the tool would have returned to you directly; parse structured results with json.loads. ' +
      "An exact-name lookup dict is also available: tools['mcpl--discord--fetch_history']({...}). " +
      'Use top-level await; run independent calls in parallel with asyncio.gather. ' +
      'Only what you print() (plus stderr and the exit code) comes back to you — intermediate ' +
      'tool results stay in the script, so filter or aggregate large data there and print only ' +
      'what you need. Interpreter state (variables, imports) persists across code_execution ' +
      (idleReclaimMs === 0
        ? 'calls until it is cancelled or the host stops. '
        : `calls but is reclaimed after ~${idleMinutes} minutes idle. `) +
      `A tool call that receives no response within ~${callTimeoutSeconds}s raises TimeoutError inside the script. ` +
      `A foreground script is stopped after ${formatLimit(limits.defaultMs)}; pass time_limit_ms to set this call's limit ` +
      `(at most ${formatLimit(limits.maxMs)}; a background script runs up to ${formatLimit(limits.backgroundMaxMs)}). ` +
      'Stopping a script does not stop tools it already called. ' +
      `WAITING: each call waits for the script up to ${waitMs}ms by default (wait_ms sets this, 0–${MAX_WAIT_MS}). ` +
      'If it is still running then, you get its script_id with status "running"; the script keeps going ' +
      'and its completion notifies you. {"action": "wait", "script_id": "..."} waits again or retrieves ' +
      'the result (wait_ms=0 just checks); on_timeout="end_turn" ends your turn instead of continuing, ' +
      'and the completion wakes you. Waiting never stops the script. While a foreground script runs, ' +
      'your interpreter is busy: wait for it, cancel it, or use background=true. ' +
      'Subagents that end with their run always wait for the script to finish. ' +
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
      'Its print() output streams to a workspace log file you can read any time. Wakes are ' +
      'rate-limited (early wakes are delayed, not dropped) and capped per script. ' +
      'CAUTION: background scripts die silently if the host process restarts — for a wake ' +
      'you absolutely must not miss, also arm a wake rule as backup. ' +
      'Manage your scripts with {"action": "list"} and {"action": "cancel", "script_id": "..."}. ' +
      `Results live in memory and are lost on a host restart: one a completion notice told you about is kept ` +
      `until you retrieve it (up to ${MAX_ANNOUNCED_RESULTS}), and the ${MAX_RETAINED_RESULTS} most recent others are kept.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Top-level await is allowed.',
        },
        background: {
          type: 'boolean',
          description:
            'Run detached as a background watcher with wake_agent() available (default false). ' +
            'Returns immediately unless wait_ms or on_timeout is given; if such a wait times out, completion notifies you.',
        },
        action: {
          type: 'string',
          enum: ['run', 'wait', 'list', 'cancel'],
          description:
            'run (default) executes `code`; wait waits for or retrieves a script by script_id; ' +
            'list shows your scripts; cancel stops one.',
        },
        script_id: {
          type: 'string',
          description: 'Script id (for action: wait or cancel).',
        },
        wait_ms: {
          type: 'integer',
          description:
            `How long this call waits for the script, 0–${MAX_WAIT_MS} milliseconds (default ${waitMs}). ` +
            'Does not limit how long the script runs.',
        },
        on_timeout: {
          type: 'string',
          enum: ['continue', 'end_turn'],
          description: 'If the script is still running when wait_ms runs out: continue your turn (default) or end it. Completion notifies you either way.',
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
    // A ceiling below the default is refused when the framework is created
    // (validateCodeExecutionConfig); never below the default here either.
    maxMs: Math.min(MAX_TIMER_MS, Math.max(defaultMs, opts?.maxScriptTimeoutMs ?? defaultMs)),
    backgroundMaxMs: Math.min(MAX_TIMER_MS, opts?.backgroundMaxLifetimeMs ?? 86_400_000),
  };
}

/** True for a valid observation budget: an integer from 0 to MAX_WAIT_MS. */
export function isValidWaitMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_WAIT_MS;
}

/** Refuse a configuration whose limits contradict each other or are out of range. */
export function validateCodeExecutionConfig(cfg: {
  scriptTimeoutMs?: number;
  maxScriptTimeoutMs?: number;
  foregroundWaitMs?: number;
}): void {
  const defaultMs = cfg.scriptTimeoutMs ?? 600_000;
  if (cfg.maxScriptTimeoutMs !== undefined && !(cfg.maxScriptTimeoutMs >= defaultMs)) {
    throw new Error(
      `codeExecution.maxScriptTimeoutMs (${cfg.maxScriptTimeoutMs}) must be at least scriptTimeoutMs (${defaultMs}): ` +
        'it is the most an agent may ask for, and the default is always allowed',
    );
  }
  // Checked here, not per call: an invalid default would otherwise refuse
  // every call that omits wait_ms, list and cancel included.
  if (cfg.foregroundWaitMs !== undefined && !isValidWaitMs(cfg.foregroundWaitMs)) {
    throw new Error(
      `codeExecution.foregroundWaitMs (${cfg.foregroundWaitMs}) must be an integer from 0 to ${MAX_WAIT_MS}`,
    );
  }
}
