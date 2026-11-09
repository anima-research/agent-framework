import type { ContentBlock, SystemChangeContent } from '@animalabs/membrane';
import type { EffortLevel } from './types/framework.js';

export interface EffortPlan {
  topLevel?: EffortLevel;
  rows: boolean;
  change?: EffortLevel;
}

export type EffortPlanner = (use: 'turn' | 'preview' | 'direct') => EffortPlan | undefined;

export const EFFORT_ROW_PARTICIPANT = 'system';

export function effortChange(level: EffortLevel): ContentBlock {
  return { type: 'system_change', effort: level } as SystemChangeContent as ContentBlock;
}

export function effortOf(content: readonly ContentBlock[]): EffortLevel | undefined {
  for (const block of content) {
    if (block.type === 'system_change' && (block as SystemChangeContent).effort !== undefined) {
      return (block as SystemChangeContent).effort;
    }
  }
  return undefined;
}

export function withTopLevelEffort<T extends { providerParams?: Record<string, unknown> }>(settings: T, plan: EffortPlan | undefined): T {
  if (plan?.topLevel === undefined) return settings;
  const params = settings.providerParams ?? {};
  const config = params.output_config !== null && typeof params.output_config === 'object' ? params.output_config : {};
  return { ...settings, providerParams: { ...params, output_config: { ...config, effort: plan.topLevel } } };
}
