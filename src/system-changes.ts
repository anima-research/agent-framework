import type { CompileResult, MessageId } from '@animalabs/context-manager';
import { isSystemChangeContent, type ContentBlock, type SystemChangeContent, type ToolDefinition } from '@animalabs/membrane';
import { canonicalJson } from './stable-hash.js';

export interface HeadDeclaration {
  tools: ToolDefinition[];
  system: string[];
}

/** An agent's record for a branch is its head alone, written when the head
 *  moves. */
export interface HeadDeclarationStore {
  read(agentName: string): HeadDeclaration | null;
  write(agentName: string, head: HeadDeclaration): boolean;
  delete(agentName: string): boolean;
}

export function memoryHeadDeclarations(branch: () => string): HeadDeclarationStore {
  const heads = new Map<string, HeadDeclaration>();
  const key = (agentName: string) => JSON.stringify([branch(), agentName]);
  // An agent that has recorded nothing asks no branch of its context.
  return {
    read: (agentName) => (heads.size === 0 ? null : heads.get(key(agentName)) ?? null),
    write: (agentName, head) => { heads.set(key(agentName), head); return true; },
    delete: (agentName) => { if (heads.size > 0) heads.delete(key(agentName)); return true; },
  };
}

// membrane renders a change by its block, whatever its participant.
export const SYSTEM_CHANGE_PARTICIPANT = 'system';

export function isHeadDeclaration(value: unknown): value is HeadDeclaration {
  if (!value || typeof value !== 'object' || !('tools' in value) || !('system' in value)) return false;
  const { tools, system } = value;
  return Array.isArray(tools)
    && tools.every((tool: unknown) => !!tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string')
    && Array.isArray(system) && system.every((block: unknown) => typeof block === 'string');
}

/** The `kind` a change row's metadata carries beside `system: true`. */
export const SYSTEM_CHANGE_KIND = 'system-change';

/** The metadata a change row is stored with: agent-framework's marker for a
 *  row that isn't conversation, the agent it declares for, whose context it
 *  is (contextAgentOf), as a stored injection's mark names its agent, and the
 *  agent's count of finished inferences when it was stored, which the rule
 *  for cost reads (carriedCharacters). An agent with no count stores none. */
export function systemChangeMetadata(
  agentName: string,
  inferenceCount?: number,
): { system: true; kind: typeof SYSTEM_CHANGE_KIND; agent: string; inferenceCount?: number } {
  return { system: true, kind: SYSTEM_CHANGE_KIND, agent: agentName, ...(inferenceCount === undefined ? {} : { inferenceCount }) };
}

/** A change row's count of finished inferences at its storing, from its mark
 *  (systemChangeMetadata). Undefined for a row with none: a copy of a
 *  context's row, which carries no metadata of its own, and a host's row. */
export function inferenceCountOf(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== 'object' || !('kind' in metadata) || metadata.kind !== SYSTEM_CHANGE_KIND) return undefined;
  const count = 'inferenceCount' in metadata ? metadata.inferenceCount : undefined;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** A move for cost's figures, each an estimate: what carrying has cost
 *  (`carried`), the cache write price over the read price less one (`k`), and
 *  what the move writes that the request would otherwise read (`extraNow`),
 *  both in characters. The head moves when `carried >= k * extraNow`. */
export interface CostFigures {
  carried: number;
  k: number;
  extraNow: number;
}

export type HeadEvent =
  | { type: 'head:declared'; removed: string[]; defined: string[]; addedSystem: number }
  | { type: 'head:moved'; why: 'adopted' | 'replaced' | 'unstored' | 'budget' | 'on-head'; changesRemoved: number }
  | { type: 'head:moved'; why: 'cost'; changesRemoved: number; estimated: CostFigures };

export type DeclarationDifference =
  | { kind: 'none' }
  | { kind: 'change'; block: SystemChangeContent }
  | { kind: 'replace' };

/**
 * Whether a message is a system change row: its content holds `system_change`
 * blocks. context-manager refuses a row that mixes them with other blocks, so
 * such a row holds changes alone. Read from the blocks, whatever metadata the
 * row carries, since a copy of a context and a host's own row carry no mark.
 * A host's reader that takes conversation alone leaves such a row out, as it
 * leaves a stored injection out (storedInjectionMarkOf), and the readers of a
 * request's tail look past it.
 */
export function isSystemChangeMessage(message: { content: readonly ContentBlock[] }): boolean {
  return Array.isArray(message.content) && message.content.some(isSystemChangeContent);
}

/** A message that declares tools or system text: one whose system changes
 *  remove or define a tool, or add system text. One whose changes carry only
 *  `effort` declares none. */
export function isDeclarationRow(message: { content: readonly ContentBlock[] }): boolean {
  return Array.isArray(message.content) && message.content.some((block) => isSystemChangeContent(block)
    && ((block.removeTools?.length ?? 0) > 0 || (block.defineTools?.length ?? 0) > 0 || (block.addSystem?.length ?? 0) > 0));
}

/** The compiled messages that are declaration rows, by index: every one the
 *  compile holds, whoever stored it. */
export function heldDeclarations(compiled: Pick<CompileResult, 'messages'>): Set<number> {
  const held = new Set<number>();
  compiled.messages.forEach((message, index) => {
    if (isDeclarationRow(message)) held.add(index);
  });
  return held;
}

/** The stored rows the compile's declaration rows came from, by its own
 *  account of each message's source. */
export function declarationRowIds(compiled: Pick<CompileResult, 'messages' | 'provenance'>): MessageId[] {
  const sources = compiled.provenance?.messages;
  return [...heldDeclarations(compiled)].flatMap((index) => {
    const source = sources?.[index];
    return source?.kind === 'raw' ? source.bodies.map((body) => body.messageId) : [];
  });
}

export function copyHead(head: HeadDeclaration): HeadDeclaration {
  return { tools: JSON.parse(JSON.stringify(head.tools)) as ToolDefinition[], system: [...head.system] };
}

/** What carrying the tool definitions that a move would take out has cost
 *  by the agent's count of finished inferences (`count`), in characters read.
 *  A definition is dead once a row removes or replaces it, if the head
 *  carries it or a row that the agent's context can remove carries it. Each
 *  dead definition counts once for each inference since the row that killed
 *  it was stored (inferenceCountOf). A row adds nothing that has no count:
 *  one that the agent's context can't read back, which its caller gives none,
 *  a copy's row and a host's row. Nor does one whose count is above `count`,
 *  as after a usage state that was reset. An addition, a row's own wrapping
 *  and system text add nothing. */
export function carriedCharacters(
  head: HeadDeclaration,
  rows: readonly { changes: readonly SystemChangeContent[]; removable: boolean; inferenceCount: number | undefined }[],
  count: number,
): number {
  const live = new Map(head.tools.map((tool) => [tool.name, pricedCharacters(tool)] as const));
  let carried = 0;
  for (const { changes, removable, inferenceCount } of rows) {
    const since = inferenceCount !== undefined && inferenceCount <= count ? count - inferenceCount : 0;
    for (const change of changes) {
      for (const name of change.removeTools ?? []) {
        carried += (live.get(name) ?? 0) * since;
        live.delete(name);
      }
      for (const tool of change.defineTools ?? []) {
        carried += (live.get(tool.name) ?? 0) * since;
        live.set(tool.name, removable ? pricedCharacters(tool) : 0);
      }
    }
  }
  return carried;
}

export function requestCharacters(head: HeadDeclaration, messages: readonly unknown[]): number {
  return pricedCharacters({ system: head.system, tools: head.tools, messages });
}

export function pricedCharacters(value: unknown): number {
  return JSON.stringify(value, unpricedLeftOut).length;
}

const UNPRICED_BLOCK_FIELDS = new Set(['rawItem', 'rawXml', 'rawXmlImagesAt', 'unparseableInput', 'tokenEstimate']);

function unpricedLeftOut(this: unknown, key: string, value: unknown): unknown {
  const type = this !== null && typeof this === 'object' && 'type' in this ? this.type : undefined;
  if (typeof type === 'string' && UNPRICED_BLOCK_FIELDS.has(key)) return undefined;
  if (key === 'data' && (type === 'base64' || type === 'generated_image' || type === 'redacted_thinking')) return undefined;
  if (key === 'signature' && type === 'thinking') return undefined;
  return value;
}

export function systemTextOf(blocks: readonly string[]): string {
  return blocks.join('\n');
}

function wireJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value) ?? 'null'));
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
  // System text is a sequence: the current blocks either continue the
  // effective ones, and the blocks after them are an addition, or they
  // replace them.
  if (!effective.system.every((block, i) => block === current.system[i])) return { kind: 'replace' };
  const addSystem = current.system.slice(effective.system.length);

  const currentNames = new Set(current.tools.map((tool) => tool.name));
  const removeTools = [...effective.tools.keys()].filter((name) => !currentNames.has(name));
  const defineTools = current.tools.filter((tool) => {
    const before = effective.tools.get(tool.name);
    return !before || wireJson(before) !== wireJson(tool);
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

