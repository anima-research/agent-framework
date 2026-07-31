/**
 * Client-side programmatic tool calling (PTC) for the connectome native stack.
 *
 * Mirrors the surface Anthropic's server-side PTC was trained on
 * (code_execution tool + tools exposed as async python functions), but runs
 * the interpreter on the host and dispatches inner tool calls in-process
 * through the framework's own tool routing — intermediate results never
 * enter the model's context; the full trace stays on-box.
 */

export { PyRunner, buildInjectedTools } from './py-runner.js';
export type {
  InjectedTool,
  ExecResult,
  PyRunnerOptions,
  ScriptToolCallHandler,
  BackgroundExecOptions,
} from './py-runner.js';
export { PYTHON_RUNTIME_SOURCE } from './runtime-py.js';
export { buildCodeExecutionToolDefinition, CODE_EXECUTION_TOOL_NAME } from './tool-definition.js';
