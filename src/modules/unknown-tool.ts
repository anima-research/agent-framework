import type { ToolDefinition } from '../types/events.js';

/**
 * What a module answers for a tool name it doesn't route: there's no such
 * tool, so nothing ran, and which tools the module has, read from its own
 * getTools() so the list can't drift. The registry hands every `module--name`
 * to its module, even one the module doesn't declare, since some modules route
 * undeclared names on purpose, so this answer is the module's to give.
 */
export function unknownToolMessage(module: string, name: string, tools: readonly Pick<ToolDefinition, 'name'>[]): string {
  const missing = `There's no tool "${module}--${name}", so nothing ran.`;
  const names = tools.map((tool) => `${module}--${tool.name}`);
  if (names.length === 0) return `${missing} The ${module} module has no tools of its own: every tool you can call is in your tool list.`;
  if (names.length === 1) return `${missing} The ${module} module's one tool is ${names[0]}.`;
  return `${missing} The ${module} module's tools are ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
}
