import { MembraneError } from '@animalabs/membrane';
import { PROGRESS_BOUNDS, resolveProgressBounds, type ProgressBounds } from '@animalabs/membrane/progress-bounds';

/** FrameworkConfig.inferenceBounds: how long the framework lets a model call
 *  go without progress. */
export interface InferenceBoundsOptions {
  /** Membrane's phase bounds for a stream whose adapter reports content
   *  (Anthropic, Bedrock), and the values the flat and whole-call bounds
   *  derive from: the larger of `beforeContentMs` and `betweenEventsMs`,
   *  plus `max_tokens` at `thinkTokensPerSecond`. Each one given replaces
   *  membrane's default (PROGRESS_BOUNDS). */
  progressBounds?: Partial<ProgressBounds>;
  /** The least the flat bound on a stream can be, from its last provider
   *  event. Default FLAT_MINIMUM_MS. */
  flatMinimumMs?: number;
}

export const FLAT_MINIMUM_MS = 1_862_000;

export interface InferenceBounds {
  readonly progressBounds: Readonly<ProgressBounds>;
  readonly flatMinimumMs: number;
}

export function resolveInferenceBounds(option: false | InferenceBoundsOptions | undefined): InferenceBounds | null {
  if (option === false) return null;
  if (option !== undefined && (typeof option !== 'object' || option === null)) {
    throw new TypeError(`[agent-framework] inferenceBounds must be false or an object, got ${option === null ? 'null' : typeof option}`);
  }
  const given = option?.progressBounds;
  if (given !== undefined && (typeof given !== 'object' || given === null)) {
    throw new TypeError(`[agent-framework] inferenceBounds.progressBounds must be an object of bounds, got ${given === null ? 'null' : typeof given}`);
  }
  let progressBounds: ProgressBounds;
  try {
    progressBounds = resolveProgressBounds(given ?? true) ?? { ...PROGRESS_BOUNDS };
  } catch (refused) {
    const why = refused instanceof Error ? refused.message.replace(/^\[membrane\] /, '') : String(refused);
    throw new (refused instanceof TypeError ? TypeError : RangeError)(`[agent-framework] inferenceBounds.${why}`);
  }
  const flatMinimumMs: unknown = option?.flatMinimumMs === undefined ? FLAT_MINIMUM_MS : option.flatMinimumMs;
  if (typeof flatMinimumMs !== 'number' || !Number.isFinite(flatMinimumMs) || flatMinimumMs <= 0) {
    throw new RangeError(`[agent-framework] inferenceBounds.flatMinimumMs must be a finite number above 0, got ${String(flatMinimumMs)}`);
  }
  return Object.freeze({ progressBounds: Object.freeze(progressBounds), flatMinimumMs });
}

function allowanceMs(bounds: Readonly<ProgressBounds>, maxTokens: number | undefined): number {
  return typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.ceil(maxTokens / bounds.thinkTokensPerSecond) * 1000
    : 0;
}

function setupMs(bounds: Readonly<ProgressBounds>): number {
  return Math.max(bounds.beforeContentMs, bounds.betweenEventsMs);
}

export function streamBounds(
  bounds: InferenceBounds | null,
  maxTokens: number | undefined,
): { progressBounds?: Readonly<ProgressBounds>; progressTimeoutMs?: number } {
  if (bounds === null) return {};
  const phases = bounds.progressBounds;
  return {
    progressBounds: phases,
    progressTimeoutMs: Math.max(setupMs(phases) + allowanceMs(phases, maxTokens), bounds.flatMinimumMs),
  };
}

export function wholeCallMs(bounds: InferenceBounds, maxTokens: number | undefined): number {
  if (!(typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0)) return Math.max(setupMs(bounds.progressBounds), bounds.flatMinimumMs);
  return setupMs(bounds.progressBounds) + allowanceMs(bounds.progressBounds, maxTokens);
}

// membrane 0.8.0 marks a deadline it reports as run out with this registered
// symbol (on a sent request, or the Anthropic SDK's timeout, which covers its
// connect timeout too) and exports no reader or marker for it. The one reader:
// the deadline class here and the transient-failure check of an exhausted
// turn's re-arm both use it.
const DEADLINE_EXPIRY = Symbol.for('membrane.deadlineExpiry');

export function isDeadlineExpiry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[DEADLINE_EXPIRY] === true;
}

/**
 * Names the host setting for the bound a stream cut hit, read from the opening
 * of membrane 0.8.0's message for it (its progress-bounds.ts and
 * providers/utils.ts), so the reason an operator and the agent see names the
 * host's setting for that bound, as the README's table maps them. A message it
 * doesn't know is left as it is.
 */
export function withHostSetting(message: string): string {
  const setting = message.includes('of a thinking block\'s start') ? 'progressBounds.thinkTokensPerSecond'
    : message.startsWith('No content within ') ? 'progressBounds.beforeContentMs'
    : message.startsWith('No provider event within ') ? 'progressBounds.betweenEventsMs'
    : message.startsWith('No provider progress within ') ? 'flatMinimumMs'
    : undefined;
  return setting === undefined ? message : `${message} (the host's setting for this bound: \`inferenceBounds.${setting}\`)`;
}

export function deadlineCut(message: string | undefined): MembraneError {
  const error = new MembraneError({
    type: 'timeout',
    retryable: false,
    message: message === undefined ? 'The provider made no progress within the call\'s bound' : withHostSetting(message),
    rawError: undefined,
  });
  Object.defineProperty(error, DEADLINE_EXPIRY, { value: true });
  return error;
}
