/** Compact agent-facing surface for Python orchestration and its execution lifecycle. */
import type { ToolDefinition } from '../types/index.js';

export const CODE_EXECUTION_TOOL_NAME = 'code_execution';

export function buildCodeExecutionToolDefinition(opts?: {
  idleReclaimMs?: number;
  toolCallTimeoutMs?: number;
  foregroundWaitMs?: number;
}): ToolDefinition {
  const idleMs = opts?.idleReclaimMs ?? 300_000;
  const reuse = idleMs === 0 ? 'until cancelled or the host stops' : `until ${idleMs}ms idle`;
  return {
    name: CODE_EXECUTION_TOOL_NAME,
    description:
      'Run Python with top-level await. Tools are async Python functions taking one dict and returning text; ' +
      "use tools['exact-tool-name']({...}) or the sanitized name ('--' becomes '__', other punctuation becomes '_'). " +
      'Use asyncio.gather for parallel calls. Tool errors return Error: text; image results become placeholders. ' +
      'Only printed stdout, stderr and return_code reach you; intermediate results stay in Python. ' +
      'Choose direct calls or code as useful, including for a single call. ' +
      `The tool waits at most ${opts?.foregroundWaitMs ?? 10_000}ms by default (override with wait_ms), then returns a running script_id. ` +
      'The script continues and completion notifies you. Use action=wait with script_id to inspect or wait again; ' +
      'wait_ms=0 inspects immediately. on_timeout=end_turn ends your turn if still running, with completion waking you. ' +
      'A wait timeout does not cancel execution. ' +
      `Ordinary calls share one Python interpreter; variables/imports persist ${reuse}. ` +
      'While a script is running that context is busy. background=true starts an independent interpreter, returns immediately, ' +
      'and makes await wake_agent(payload) available for explicit notifications. Clean background exits are silent unless ' +
      'you wait and yield; crashes notify you. Output is journaled to the reported workspace log when available. ' +
      'Background scripts are primary-agent-only; wakes are rate limited. action=list lists your scripts; action=cancel stops one. ' +
      `Inner tool calls time out after ${opts?.toolCallTimeoutMs ?? 270_000}ms. ` +
      'Cancellation stops Python, but already dispatched tools may still finish. ' +
      'Scripts and retained results do not survive host restart; the five most recently settled results are retained per agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Python code; top-level await is supported.' },
        action: { type: 'string', enum: ['run', 'wait', 'list', 'cancel'], description: 'run (default), wait/inspect a script, list scripts, or cancel one.' },
        script_id: { type: 'string', description: 'Execution id for wait or cancel.' },
        wait_ms: { type: 'integer', description: 'Observation budget, 0–60000 milliseconds; 0 returns immediately. Does not limit script lifetime.' },
        on_timeout: { type: 'string', enum: ['continue', 'end_turn'], description: 'After the observation budget expires, continue thinking (default) or end this turn. Completion will notify/wake you.' },
        background: { type: 'boolean', description: 'Independent interpreter with wake_agent and output journal. Returns immediately unless wait_ms or on_timeout is supplied.' },
      },
      required: [],
    },
  };
}
