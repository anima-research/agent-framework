/**
 * Client-side programmatic tool calling (`code_execution`): an agent's
 * scripts call its other tools in-process through the framework's own tool
 * routing, so intermediate results never enter the model's context. Each
 * script runs in a process of its own, in QuickJS compiled to WebAssembly
 * (engine.ts), and reaches nothing but the agent's tools.
 */

export { buildCodeExecutionToolDefinition, CODE_EXECUTION_TOOL_NAME } from './tool-definition.js';
