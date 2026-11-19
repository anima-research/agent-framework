import { jsonTokenEstimator, type CompileResult, type MessageId } from '@animalabs/context-manager';
import { isSystemChangeContent, type ContentBlock, type SystemChangeContent, type ToolDefinition } from '@animalabs/membrane';
import { mediaBlockTokens } from './media-tokens.js';
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

export const SYSTEM_CHANGE_KIND = 'system-change';

export function systemChangeMetadata(
  agentName: string,
  requestCount?: number,
): { system: true; kind: typeof SYSTEM_CHANGE_KIND; agent: string; requestCount?: number } {
  return { system: true, kind: SYSTEM_CHANGE_KIND, agent: agentName, ...(requestCount === undefined ? {} : { requestCount }) };
}

export function storedRequestCount(metadata: unknown): number | undefined {
  if (metadata === null || typeof metadata !== 'object' || !('kind' in metadata) || metadata.kind !== SYSTEM_CHANGE_KIND) return undefined;
  const count = 'requestCount' in metadata ? metadata.requestCount : undefined;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export interface CostFigures {
  carried: number;
  k: number;
  extraNow: number;
}

export type HeadEvent =
  | { type: 'head:declared'; removed: string[]; defined: string[]; addedSystem: number }
  | { type: 'head:moved'; why: 'adopted' | 'replaced' | 'budget' | 'on-head'; changesRemoved: number }
  | { type: 'head:moved'; why: 'unstored'; changesRemoved: number; error: string }
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
 * leaves a stored injection out (storedInjectionMarkOf).
 */
export function isSystemChangeMessage(message: { content: readonly ContentBlock[] }): boolean {
  return Array.isArray(message.content) && message.content.some(isSystemChangeContent);
}

export function isDeclarationRow(message: { content: readonly ContentBlock[] }): boolean {
  return Array.isArray(message.content) && message.content.some((block) => isSystemChangeContent(block)
    && ((block.removeTools?.length ?? 0) > 0 || (block.defineTools?.length ?? 0) > 0 || (block.addSystem?.length ?? 0) > 0));
}

export function heldDeclarations(compiled: Pick<CompileResult, 'messages'>): Set<number> {
  const held = new Set<number>();
  compiled.messages.forEach((message, index) => {
    if (isDeclarationRow(message)) held.add(index);
  });
  return held;
}

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

export function carriedTokens(
  head: HeadDeclaration,
  rows: readonly { changes: readonly SystemChangeContent[]; removable: boolean; requestCount: number | undefined }[],
  count: number,
): number {
  const live = new Map(head.tools.map((tool) => [tool.name, pricedTokens(tool)] as const));
  let carried = 0;
  for (const { changes, removable, requestCount } of rows) {
    const since = requestCount !== undefined && requestCount <= count ? count - requestCount : 0;
    for (const change of changes) {
      for (const name of change.removeTools ?? []) {
        carried += (live.get(name) ?? 0) * since;
        live.delete(name);
      }
      for (const tool of change.defineTools ?? []) {
        carried += (live.get(tool.name) ?? 0) * since;
        live.set(tool.name, removable ? pricedTokens(tool) : 0);
      }
    }
  }
  return carried;
}

export function requestTokens(head: HeadDeclaration, messages: readonly { content: readonly unknown[] }[]): number {
  return pricedTokens({ system: head.system, tools: head.tools, messages })
    + messages.reduce((tokens, message) => tokens + mediaTokens(message.content), 0);
}

export function pricedTokens(value: unknown): number {
  return jsonTokenEstimator(JSON.stringify(value, unpricedLeftOut));
}

function mediaTokens(blocks: readonly unknown[]): number {
  let tokens = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue;
    if (block.type === 'tool_result' && 'content' in block && Array.isArray(block.content)) tokens += mediaTokens(block.content);
    else tokens += mediaBlockTokens(block as ContentBlock);
  }
  return tokens;
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

function continuedAt(effective: readonly string[], current: readonly string[]): number {
  if (effective.length === 0) return 0;
  const text = systemTextOf(effective);
  for (let at = 1; at <= current.length; at++) if (systemTextOf(current.slice(0, at)) === text) return at;
  return -1;
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
  const at = continuedAt(effective.system, current.system);
  if (at < 0) return { kind: 'replace' };
  const addSystem = current.system.slice(at);

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

