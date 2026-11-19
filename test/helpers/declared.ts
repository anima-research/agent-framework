import type { NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

const byName = (tools: Iterable<ToolDefinition>) => [...tools].sort((a, b) => a.name.localeCompare(b.name));

export function foldOf(request: Pick<NormalizedRequest, 'tools' | 'system' | 'messages'>): { tools: ToolDefinition[]; system: string } {
  const tools = new Map((request.tools ?? []).map((t) => [t.name, t]));
  const system = [request.system ?? ''];
  for (const block of request.messages.flatMap((m) => m.content)) {
    if (block.type !== 'system_change') continue;
    for (const name of block.removeTools ?? []) tools.delete(name);
    for (const defined of block.defineTools ?? []) tools.set(defined.name, defined);
    system.push(...(block.addSystem ?? []));
  }
  return { tools: byName(tools.values()), system: system.join('\n') };
}

export function now(tools: readonly ToolDefinition[], system: string): { tools: ToolDefinition[]; system: string } {
  return { tools: byName(tools), system };
}
