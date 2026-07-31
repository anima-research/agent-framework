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

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

export function buildCodeExecutionToolDefinition(opts?: {
  idleReclaimMs?: number;
  toolCallTimeoutMs?: number;
}): ToolDefinition {
  const idleMinutes = Math.max(1, Math.round((opts?.idleReclaimMs ?? 300_000) / 60_000));
  const callTimeoutSeconds = Math.round((opts?.toolCallTimeoutMs ?? 270_000) / 1000);
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
      `calls but is reclaimed after ~${idleMinutes} minutes idle. A tool call that receives no ` +
      `response within ~${callTimeoutSeconds}s raises TimeoutError inside the script. ` +
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
      },
      required: [],
    },
  };
}
