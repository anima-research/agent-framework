import * as membrane from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import type { CompileResult, ContextManager, MessageId, MessageMetadata } from '@animalabs/context-manager';
import type { EffortLevel } from './types/framework.js';

// Membrane sends an effort-only `system_change` from the release that exports `SYSTEM_CHANGE_EFFORT` (0.10.0); an
// earlier one leaves it out unsent.
export const MEMBRANE_SENDS_EFFORT_ROWS = (membrane as unknown as Record<string, unknown>).SYSTEM_CHANGE_EFFORT === true;

// Membrane before 0.10.0 types `SystemChangeContent` without `effort`.
interface EffortChange { type: 'system_change'; effort?: EffortLevel }

export interface EffortPlan {
  topLevel?: EffortLevel;
  rows: boolean;
  change?: EffortLevel;
}

export type EffortPlanner = (use: 'turn' | 'preview' | 'direct') => EffortPlan | undefined;

export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

export const EFFORT_ROW_PARTICIPANT = 'system';

export const EFFORT_ROW_KEY = 'effortRowOf';

export const EFFORT_ROW_KIND = 'effort-change';

export function effortRowMetadata(agentName: string): MessageMetadata {
  return { [EFFORT_ROW_KEY]: agentName, system: true, kind: EFFORT_ROW_KIND } as MessageMetadata;
}

export function effortRowOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const of = (metadata as Record<string, unknown>)[EFFORT_ROW_KEY];
  return typeof of === 'string' ? of : undefined;
}

export function isAnotherAgentsEffortRow(metadata: unknown, agentName: string): boolean {
  const of = effortRowOf(metadata);
  return of !== undefined && of !== agentName;
}

export function effortMarksOf(
  cm: Pick<ContextManager, 'getMessage'>,
  result: Pick<CompileResult, 'provenance'>,
  unread: (id: MessageId, error: unknown) => void,
): (i: number) => Array<string | undefined> {
  const markOf = (id: MessageId): string | undefined => {
    try {
      return effortRowOf(cm.getMessage(id)?.metadata);
    } catch (error) {
      unread(id, error);
      return undefined;
    }
  };
  return (i) => {
    const source = result.provenance?.messages[i];
    return source?.kind === 'raw' ? source.bodies.map((body) => markOf(body.messageId)) : [];
  };
}

export function keepsEffortRow(plan: EffortPlan | undefined, marks: ReadonlyArray<string | undefined>): boolean {
  if (plan === undefined) return marks.every((of) => of === undefined);
  return plan.rows && marks.length > 0 && marks.every((of) => of !== undefined);
}

export function effortChange(level: EffortLevel): ContentBlock {
  return { type: 'system_change', effort: level } satisfies EffortChange as unknown as ContentBlock;
}

export function effortOf(content: readonly ContentBlock[]): EffortLevel | undefined {
  for (const block of content) {
    const effort = block.type === 'system_change' ? (block as unknown as EffortChange).effort : undefined;
    if (effort !== undefined) return effort;
  }
  return undefined;
}

export function withTopLevelEffort<T extends { providerParams?: Record<string, unknown> }>(settings: T, plan: EffortPlan | undefined): T {
  if (plan?.topLevel === undefined) return settings;
  const params = settings.providerParams ?? {};
  const config = params.output_config !== null && typeof params.output_config === 'object' ? params.output_config : {};
  return { ...settings, providerParams: { ...params, output_config: { ...config, effort: plan.topLevel } } };
}
