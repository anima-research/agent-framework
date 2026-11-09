import * as membrane from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import type { EffortLevel } from './types/framework.js';

/** Membrane sends an effort-only `system_change` from the release that exports `SYSTEM_CHANGE_EFFORT` (0.10.0); an earlier one leaves it out unsent. */
export const MEMBRANE_SENDS_EFFORT_ROWS = (membrane as unknown as Record<string, unknown>).SYSTEM_CHANGE_EFFORT === true;

/** Membrane before 0.10.0 types `SystemChangeContent` without `effort`. */
interface EffortChange { type: 'system_change'; effort?: EffortLevel }

export interface EffortPlan {
  topLevel?: EffortLevel;
  rows: boolean;
  change?: EffortLevel;
}

export type EffortPlanner = (use: 'turn' | 'preview' | 'direct') => EffortPlan | undefined;

export const EFFORT_ROW_PARTICIPANT = 'system';

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
