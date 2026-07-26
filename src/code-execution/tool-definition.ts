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
      "the function name is the tool name with '--' replaced by '__' " +
      "(e.g. tool 'mcpl--discord--fetch_history' is the function mcpl__discord__fetch_history). " +
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
      'result before deciding the next step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Top-level await is allowed.',
        },
      },
      required: ['code'],
    },
  };
}
