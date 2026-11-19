import type { CompileResult, MessageId } from '@animalabs/context-manager';
import { isSystemChangeContent, type ContentBlock, type SystemChangeContent, type ToolDefinition } from '@animalabs/membrane';
import { canonicalJson } from './stable-hash.js';

export interface HeadDeclaration {
  tools: ToolDefinition[];
  system: string[];
}

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
 *  row that isn't conversation, and the agent it declares for, whose context
 *  it is (contextAgentOf), as a stored injection's mark names its agent. */
export function systemChangeMetadata(agentName: string): { system: true; kind: typeof SYSTEM_CHANGE_KIND; agent: string } {
  return { system: true, kind: SYSTEM_CHANGE_KIND, agent: agentName };
}

export type HeadEvent =
  | { type: 'head:declared'; removed: string[]; defined: string[]; addedSystem: number }
  | {
      type: 'head:moved';
      why: 'adopted' | 'replaced' | 'consolidated' | 'unstored' | 'on-head';
      changesRemoved: number;
      changeChars?: number;
      requestChars?: number;
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
 *  conversation's tail look past, are every change row. */
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

