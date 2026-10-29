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
import { continuesBody, type CompileResult } from '@animalabs/context-manager';
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

/** A stored row as a read of the store's tail gives it: its blocks, and the
 *  body it's a shard of, if any. */
export interface TailRow {
  content: readonly ContentBlock[];
  bodyGroupId?: string;
  shardIndex?: number;
}

/**
 * Whether a system change written at the end of the store would stand
 * between a tool call and its result, where a fold can part them, so
 * context-manager refuses the write. This is context-manager 0.22.0's rule
 * for it (MessageStore.refuseToolPairSplit): back over change rows and rows
 * of results, each body read whole across its shards, to the nearest body
 * that holds a call. The write splits a call of that body when neither the
 * body's own later blocks (a bundled cycle) nor a result read on the way
 * answers it. Any other row, or the store's start, ends the walk with
 * nothing split. In a shared slot the call can be another resident's.
 *
 * Give `visit` the stored rows newest first, until it returns true, when
 * it has decided; then `splits` answers, deciding at the store's start if
 * the rows ran out first.
 */
export function changeWriteCheck(): { visit(row: TailRow): boolean; splits(): boolean } {
  let body: TailRow[] = [];
  const answered = new Set<string>();
  let split: boolean | undefined;
  // Read the body in hand, in store order: true once the walk ends there.
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
      /** A consolidation no compile made free: past a fifth of the input, or a compile refused over budget. */
      forced?: 'share' | 'budget';
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

/** A copy of a head: what's recorded, so a tool definition its caller later
 *  changes in place is declared as a change rather than changing the head
 *  unseen, and what a request carries, so a change made to the request in
 *  place leaves the record as it was. A record is never changed in place, so
 *  two agents' records may be one object, as a fork's and its template's. */
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
