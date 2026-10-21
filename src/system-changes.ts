/**
 * System changes: an agent's tools and system text, declared once at the head
 * of its requests and changed afterwards by messages placed where each change
 * took effect.
 *
 * Under `toolDeclarations: 'entries'` a request's `tools` and `system` are the
 * agent's recorded head, its baseline, and each later change to its tools, or
 * addition to its system text, is a `system_change` block stored in its own
 * message. The provider then reads the cached prefix whole: a change is a few
 * appended bytes instead of a rewrite from the head. This module is the pure
 * part: recognising a change, folding the changes onto the head, and the
 * difference between that and what the agent advertises now.
 */
import { isSystemChangeContent, type ContentBlock, type SystemChangeContent, type ToolDefinition } from '@animalabs/membrane';

/** What a request's head declares: its tools, and its system text as blocks,
 *  the agent's prompt first, then each system injection's text. A request's
 *  `system` is the blocks joined by line breaks, as Agent.buildSystemPrompt
 *  joins them. */
export interface HeadDeclaration {
  tools: ToolDefinition[];
  system: string[];
}

/** Where agents' head declarations are kept between requests. The framework
 *  keeps them in its store's state, which follows the store's branches, so a
 *  branch's record goes with that branch's context; an agent built alone
 *  keeps its own in memory. A head that disagrees with the context costs at
 *  most one write, since every request compares before it goes. */
export interface HeadDeclarationStore {
  read(agentName: string): HeadDeclaration | null;
  write(agentName: string, head: HeadDeclaration): void;
  delete(agentName: string): void;
}

export function memoryHeadDeclarations(): HeadDeclarationStore {
  const heads = new Map<string, HeadDeclaration>();
  return {
    read: (agentName) => heads.get(agentName) ?? null,
    write: (agentName, head) => { heads.set(agentName, head); },
    delete: (agentName) => { heads.delete(agentName); },
  };
}

/** Who a change row is stored as. Membrane renders a change by its block, so
 *  the name only keeps it apart from every speaker. */
export const SYSTEM_CHANGE_PARTICIPANT = 'system';

/** The last message that isn't a system change: what a request ends on, since
 *  a change isn't a turn. */
export function lastConversational<M extends { content: readonly ContentBlock[] }>(messages: readonly M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (!isSystemChangeMessage(messages[i]!)) return messages[i];
  return undefined;
}

/** Whether the agent's own last turn made calls still waiting for their
 *  results: a change appended now would separate the calls from them. Other
 *  participants' messages may follow the calls in a shared slot, so the
 *  results are looked for by the calls' ids, after that turn. */
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

/** Whether the last message that isn't a system change holds a tool call,
 *  whoever made it. A change written there, counting back over other changes,
 *  would stand between the call and its result, where a fold can part them;
 *  in a shared slot the call can be another resident's. */
export function endsOnToolCall(messages: readonly { content: readonly ContentBlock[] }[]): boolean {
  return lastConversational(messages)?.content.some((block) => block.type === 'tool_use') ?? false;
}

/** A stored change row of another agent's: in the residents' shared slot,
 *  each agent's view leaves these out, since they declare another's tools. */
export function isOthersSystemChange(message: { content: readonly ContentBlock[]; metadata?: unknown }, agentName: string): boolean {
  return isSystemChangeMessage(message) && (message.metadata as { agent?: unknown } | undefined)?.agent !== agentName;
}

/** Whether a stored value reads as a head: tools by name, and system text as strings. */
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

/** What a request's assembly did to its agent's head: the framework traces
 *  it as is, with the agent's name (types/trace.ts). */
export type HeadEvent =
  | { type: 'head:declared'; removed: string[]; defined: string[]; addedSystem: number }
  | {
      type: 'head:moved';
      why: 'adopted' | 'replaced' | 'consolidated' | 'on-head';
      changesRemoved: number;
      changeTokens?: number;
      inputTokens?: number;
    };

/** The difference between a head with its changes and what the agent advertises now. */
export type DeclarationDifference =
  | { kind: 'none' }
  /** Expressible as one more change: tools added, removed or redefined, and blocks added. */
  | { kind: 'change'; block: SystemChangeContent }
  /** A block of system text changed, went or was cut: only a new head says that. */
  | { kind: 'replace' };

/** A message that holds system changes. context-manager refuses one that mixes
 *  them with other blocks, so its content is changes alone. Recognised by its
 *  block, which is what membrane sends, whatever metadata a stored copy carries. */
export function isSystemChangeMessage(message: { content: readonly ContentBlock[] }): boolean {
  return message.content.some(isSystemChangeContent);
}

/** A head to record: a copy, so a tool definition its caller later changes in
 *  place is declared as a change rather than changing the head unseen. */
export function copyHead(head: HeadDeclaration): HeadDeclaration {
  return { tools: JSON.parse(JSON.stringify(head.tools)) as ToolDefinition[], system: [...head.system] };
}

/** The system text a head's blocks make, as Agent.buildSystemPrompt joins them. */
export function systemTextOf(blocks: readonly string[]): string {
  return blocks.join('\n');
}

/** A value's JSON with every object's keys sorted, so two definitions that
 *  differ only in key order compare equal. */
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

/** The head with every change folded on, in order: for each change, its
 *  removals, then its definitions, then its text. */
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

/**
 * What it takes to go from `effective` to `current`.
 *
 * System text is compared by blocks, counted as a multiset: it's an addition
 * when every block of the effective text is still there, and the blocks left
 * over, in current order, are what's added. Anything else, a block changed,
 * gone or cut, is a replacement. A reorder of the same blocks changes nothing:
 * the head keeps its order. Tools are compared by name and canonical
 * definition, ignoring order.
 */
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
