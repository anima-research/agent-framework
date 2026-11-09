import * as membrane from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import type { CompileResult, MessageId } from '@animalabs/context-manager';
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

export function isEffortLevel(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

export const EFFORT_ROW_PARTICIPANT = 'system';

/** The metadata key on each effort row the framework stores, naming the agent it wrote the row for. */
export const EFFORT_ROW_KEY = 'effortRowOf';

/** The agent the framework wrote a stored row for as an effort row, or undefined for any other row. */
export function effortRowOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const of = (metadata as Record<string, unknown>)[EFFORT_ROW_KEY];
  return typeof of === 'string' ? of : undefined;
}

/** Where a stored row's metadata is read: a context manager's store, else its window. */
export interface EffortMarkSource {
  getMessage(id: MessageId): { metadata?: unknown } | null;
  getPresentedMessages?(): ReadonlyArray<{ id: MessageId; metadata?: unknown }>;
}

/**
 * For a compile of `cm`, the marks of each compiled message's stored rows (effortRowOf of each, one per row the
 * compile's provenance names; none where it names none). A row of a slot merged into the view isn't in the store,
 * so it's read from the window. A row the store can't read just now is told to `unread`, and counts as unmarked.
 */
export function effortMarksOf(
  cm: EffortMarkSource,
  result: Pick<CompileResult, 'provenance'>,
  unread: (id: MessageId, error: unknown) => void,
): (i: number) => Array<string | undefined> {
  let window: Map<MessageId, { metadata?: unknown }> | undefined;
  const markOf = (id: MessageId): string | undefined => {
    try {
      const row = cm.getMessage(id) ?? (window ??= new Map((cm.getPresentedMessages?.() ?? []).map((m) => [m.id, m]))).get(id);
      return effortRowOf(row?.metadata);
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

/**
 * Whether a request under `plan` carries an effort row whose stored rows carry `marks` (effortRowOf of each; none
 * where the compile can't name them). With FrameworkConfig.effort set and rows on, only the framework's rows for the
 * agent's own participants (`isOwn`) go. Set with rows off, none goes. Unset, every row but the framework's goes.
 */
export function keepsEffortRow(
  plan: EffortPlan | undefined,
  marks: ReadonlyArray<string | undefined>,
  isOwn: (participant: string) => boolean,
): boolean {
  if (plan === undefined) return marks.every((of) => of === undefined);
  return plan.rows && marks.length > 0 && marks.every((of) => of !== undefined && isOwn(of));
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
