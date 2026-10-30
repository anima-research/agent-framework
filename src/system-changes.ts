import { continuesBody, type CompileResult } from '@animalabs/context-manager';
import { isSystemChangeContent, type ContentBlock, type SystemChangeContent, type ToolDefinition } from '@animalabs/membrane';

export interface HeadDeclaration {
  tools: ToolDefinition[];
  system: string[];
}

export interface HeadDeclarationStore {
  read(agentName: string): HeadDeclaration | null;
  write(agentName: string, head: HeadDeclaration): boolean;
  delete(agentName: string): boolean;
}

export function memoryHeadDeclarations(): HeadDeclarationStore {
  const heads = new Map<string, HeadDeclaration>();
  return {
    read: (agentName) => heads.get(agentName) ?? null,
    write: (agentName, head) => { heads.set(agentName, head); return true; },
    delete: (agentName) => { heads.delete(agentName); return true; },
  };
}

// membrane renders a change by its block, whatever its participant.
export const SYSTEM_CHANGE_PARTICIPANT = 'system';

export function lastConversational<M extends { content: readonly ContentBlock[] }>(messages: readonly M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (!isSystemChangeMessage(messages[i]!)) return messages[i];
  return undefined;
}

export function endsOnUnansweredCalls(
  messages: readonly { participant: string; content: readonly ContentBlock[] }[],
  agentName: string,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i]!;
    if (turn.participant !== agentName || isSystemChangeMessage(turn)) continue;
    const calls = turn.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    if (calls.length === 0) return false;
    const answered = new Set(messages.slice(i + 1).flatMap((m) => m.content.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : []))));
    return calls.some((id) => !answered.has(id));
  }
  return false;
}

export interface TailRow {
  content: readonly ContentBlock[];
  bodyGroupId?: string;
  shardIndex?: number;
}

// context-manager 0.22.0's MessageStore.refuseToolPairSplit refuses a change
// written between a tool call and its result. Its walk: back over change rows
// and rows of results, each body read whole across its shards, to the nearest
// body that holds a call. The write splits a call of that body when neither
// the body's own later blocks nor a result read on the way answers it. Any
// other row, or the store's start, ends the walk with nothing split.
export function changeWriteCheck(): { visit(row: TailRow): boolean; splits(): boolean } {
  let body: TailRow[] = [];
  const answered = new Set<string>();
  let split: boolean | undefined;
  const readBody = (): boolean => {
    const content = body.flatMap((row) => row.content);
    body = [];
    if (content.some((block) => block.type === 'tool_use')) {
      const open = new Map<string, boolean>();
      for (const block of content) {
        if (block.type === 'tool_use') open.set(block.id, true);
        else if (block.type === 'tool_result' && open.has(block.toolUseId)) open.set(block.toolUseId, false);
      }
      split = [...open].some(([id, stillOpen]) => stillOpen && !answered.has(id));
      return true;
    }
    if (content.some(isSystemChangeContent)) return false;
    const results = content.flatMap((block) => (block.type === 'tool_result' ? [block.toolUseId] : []));
    if (results.length === 0) {
      split = false;
      return true;
    }
    for (const id of results) answered.add(id);
    return false;
  };
  return {
    visit(row) {
      if (split !== undefined) return true;
      if (body.length > 0 && !continuesBody(row, body[0]) && readBody()) return true;
      body.unshift(row);
      return false;
    },
    splits() {
      if (split === undefined && (body.length === 0 || !readBody())) split = false;
      return split!;
    },
  };
}

function changeStampOf(row: { metadata?: unknown }): string | undefined {
  const metadata = row.metadata as { kind?: unknown; agent?: unknown } | undefined;
  return metadata?.kind === 'system-change' && typeof metadata.agent === 'string' ? metadata.agent : undefined;
}

export function isOthersSystemChange(message: { content: readonly ContentBlock[]; metadata?: unknown }, isOwn: (agentName: string) => boolean): boolean {
  const stamp = changeStampOf(message);
  return isSystemChangeMessage(message) && stamp !== undefined && !isOwn(stamp);
}

export function isSystemChangeNotOwn(message: { content: readonly ContentBlock[]; metadata?: unknown }, isOwn: (agentName: string) => boolean): boolean {
  const stamp = changeStampOf(message);
  return isSystemChangeMessage(message) && (stamp === undefined || !isOwn(stamp));
}

export function isHeadDeclaration(value: unknown): value is HeadDeclaration {
  if (!value || typeof value !== 'object') return false;
  const { tools, system } = value as { tools?: unknown; system?: unknown };
  return Array.isArray(tools)
    && tools.every((tool) => !!tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string')
    && Array.isArray(system) && system.every((block) => typeof block === 'string');
}

/** The metadata a change row is stored with: agent-framework's marker for a
 *  row that isn't conversation, and the agent it declares for, which the
 *  residents' shared slot needs to keep each agent's changes its own. */
export function systemChangeMetadata(agentName: string): { system: true; kind: 'system-change'; agent: string } {
  return { system: true, kind: 'system-change', agent: agentName };
}

export type HeadEvent =
  | { type: 'head:declared'; removed: string[]; defined: string[]; addedSystem: number }
  | {
      type: 'head:moved';
      why: 'adopted' | 'replaced' | 'consolidated' | 'on-head';
      changesRemoved: number;
      changeTokens?: number;
      inputTokens?: number;
      forced?: 'share' | 'budget';
    };

export type DeclarationDifference =
  | { kind: 'none' }
  | { kind: 'change'; block: SystemChangeContent }
  | { kind: 'replace' };

/** A message that holds system changes. context-manager refuses one that mixes
 *  them with other blocks, so its content is changes alone. Recognised by its
 *  block, which is what membrane sends, whatever metadata a stored copy carries:
 *  what a request on the head leaves out, and what readers of the
 *  conversation's tail look past, are every change row. Folding onto the head
 *  and consolidating read only the agent's own (ownSystemChanges). */
export function isSystemChangeMessage(message: { content: readonly ContentBlock[] }): boolean {
  return message.content.some(isSystemChangeContent);
}

function isOwnChangeRow(row: { metadata?: unknown }, isOwn: (agentName: string) => boolean): boolean {
  const stamp = changeStampOf(row);
  return stamp !== undefined && isOwn(stamp);
}

export function ownSystemChanges(compiled: Pick<CompileResult, 'messages' | 'provenance' | 'rawBodies'>, isOwn: (agentName: string) => boolean): Set<number> {
  const own = new Set<number>();
  const sources = compiled.provenance?.messages;
  compiled.messages.forEach((message, index) => {
    if (!isSystemChangeMessage(message)) return;
    const source = sources?.[index];
    if (source?.kind !== 'raw') return;
    const rows = source.bodies.flatMap((body) => compiled.rawBodies?.get(body.messageId) ?? []);
    if (rows.length > 0 && rows.every((row) => isOwnChangeRow(row, isOwn))) own.add(index);
  });
  return own;
}

export function copyHead(head: HeadDeclaration): HeadDeclaration {
  return { tools: JSON.parse(JSON.stringify(head.tools)) as ToolDefinition[], system: [...head.system] };
}

export function systemTextOf(blocks: readonly string[]): string {
  return blocks.join('\n');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function effectiveDeclaration(
  head: HeadDeclaration,
  changes: readonly SystemChangeContent[],
): { tools: Map<string, ToolDefinition>; system: string[] } {
  const tools = new Map(head.tools.map((tool) => [tool.name, tool] as const));
  const system = [...head.system];
  for (const change of changes) {
    for (const name of change.removeTools ?? []) tools.delete(name);
    for (const tool of change.defineTools ?? []) tools.set(tool.name, tool);
    system.push(...(change.addSystem ?? []));
  }
  return { tools, system };
}

export function declarationDifference(
  effective: { tools: ReadonlyMap<string, ToolDefinition>; system: readonly string[] },
  current: HeadDeclaration,
): DeclarationDifference {
  const remaining = new Map<string, number>();
  for (const block of effective.system) remaining.set(block, (remaining.get(block) ?? 0) + 1);
  const addSystem: string[] = [];
  for (const block of current.system) {
    const left = remaining.get(block) ?? 0;
    if (left > 0) remaining.set(block, left - 1);
    else addSystem.push(block);
  }
  for (const left of remaining.values()) if (left > 0) return { kind: 'replace' };

  const currentNames = new Set(current.tools.map((tool) => tool.name));
  const removeTools = [...effective.tools.keys()].filter((name) => !currentNames.has(name));
  const defineTools = current.tools.filter((tool) => {
    const before = effective.tools.get(tool.name);
    return !before || canonicalJson(before) !== canonicalJson(tool);
  });

  if (removeTools.length === 0 && defineTools.length === 0 && addSystem.length === 0) return { kind: 'none' };
  return {
    kind: 'change',
    block: {
      type: 'system_change',
      ...(removeTools.length > 0 ? { removeTools } : {}),
      ...(defineTools.length > 0 ? { defineTools } : {}),
      ...(addSystem.length > 0 ? { addSystem } : {}),
    },
  };
}

export function withoutCarried(
  difference: DeclarationDifference,
  own: { tools: ReadonlyMap<string, ToolDefinition>; system: readonly string[] },
  carried: { tools: ReadonlyMap<string, ToolDefinition>; system: readonly string[] },
): DeclarationDifference {
  if (difference.kind !== 'change') return difference;
  const { block } = difference;
  const defineTools = (block.defineTools ?? []).filter((tool) => {
    const held = carried.tools.get(tool.name);
    return !held || canonicalJson(held) !== canonicalJson(tool);
  });
  const removeTools = (block.removeTools ?? []).filter((name) => carried.tools.has(name));
  const othersAdded = new Map<string, number>();
  for (const text of carried.system) othersAdded.set(text, (othersAdded.get(text) ?? 0) + 1);
  for (const text of own.system) othersAdded.set(text, (othersAdded.get(text) ?? 0) - 1);
  const addSystem = (block.addSystem ?? []).filter((text) => {
    const left = othersAdded.get(text) ?? 0;
    if (left <= 0) return true;
    othersAdded.set(text, left - 1);
    return false;
  });
  if (defineTools.length === 0 && removeTools.length === 0 && addSystem.length === 0) return { kind: 'none' };
  return {
    kind: 'change',
    block: {
      type: 'system_change',
      ...(removeTools.length > 0 ? { removeTools } : {}),
      ...(defineTools.length > 0 ? { defineTools } : {}),
      ...(addSystem.length > 0 ? { addSystem } : {}),
    },
  };
}
