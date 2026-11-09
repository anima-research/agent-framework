import { MembraneError } from '@animalabs/membrane';
import { OverBudgetError, UncoveredDropError } from '@animalabs/context-manager';
import { isDeadlineCut } from './inference-bounds.js';

/**
 * Longest failure text the inference-failure pipeline writes to one sink: the
 * reason in the exhaustion stderr line, a field of a logs/failures.log record,
 * an ops alert's message, the inference log's `error`, and a trace event's
 * `error` and `stack`. A failure's text is whatever its source put in
 * `Error.message`, and a provider can echo the entire rejected request there
 * (one OpenAI-compatible 400 echoed ~1.7 MB). The sinks with shorter bounds
 * name their own, and every cut goes through boundFailureText. This bound
 * doesn't depend on membrane bounding its own errors.
 */
export const FAILURE_TEXT_MAX_CHARS = 2_000;

/** Longest provider error code recorded verbatim; real codes are short tokens.
 *  A failure's name and type are bounded the same way. */
export const PROVIDER_ERROR_CODE_MAX_CHARS = 128;

const isHighSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
};
const isLowSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};
/** Whether a cut before `index` would separate the halves of a surrogate pair. */
const splitsPair = (text: string, index: number): boolean =>
  index > 0 && index < text.length && isHighSurrogate(text, index - 1) && isLowSurrogate(text, index);

/**
 * `text` when it fits within `max` characters; otherwise its head and tail
 * around a marker stating how many of how many characters were omitted, the
 * whole within `max`. A cut that would separate a surrogate pair moves toward
 * omission, so the result never holds half of a pair the text held whole, and
 * bounding bounded text returns it as is. Each sink cuts the whole text, so
 * its marker states the whole length.
 */
export function boundFailureText(text: string, max: number = FAILURE_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const markerLength = ` …[${text.length} of ${text.length} characters omitted]… `.length;
  const budget = Math.max(0, max - markerLength);
  const tailLength = Math.floor(budget / 4);
  let headEnd = budget - tailLength;
  if (splitsPair(text, headEnd)) headEnd--;
  let tailStart = text.length - tailLength;
  if (splitsPair(text, tailStart)) tailStart++;
  return `${text.slice(0, headEnd)} …[${tailStart - headEnd} of ${text.length} characters omitted]… ${text.slice(tailStart)}`;
}

/**
 * A MembraneError, from this framework's copy of membrane or from another: the
 * host supplies the Membrane instance (config.membrane), so with two copies
 * installed its errors are instances of a class this framework's `instanceof`
 * doesn't match. Recognised by name as well, as context-manager's errors are;
 * its fields are the same, so callers still check each one's type.
 */
export function isMembraneError(error: unknown): error is MembraneError {
  return error instanceof MembraneError || (error instanceof Error && error.name === 'MembraneError');
}

export function compileRefusalType(err: Error): 'over_budget' | 'context_refusal' | undefined {
  if (err instanceof OverBudgetError || err.name === 'OverBudgetError') return 'over_budget';
  // context-manager's fatal coverage invariant (fix/coverage-invariant-fatal,
  // 2026-07-26): a compile REFUSES rather than shipping a context with
  // silently-dropped messages. Recovery is identical to over_budget — kick
  // the compression drain so summaries cover the un-represented span.
  if (err instanceof UncoveredDropError || err.name === 'UncoveredDropError') return 'context_refusal';
  return undefined;
}

export function houseReason(err: Error): string | undefined {
  return isDeadlineCut(err) || compileRefusalType(err) !== undefined ? String(err.message) : undefined;
}

export function failureWords(err: Error, otherwise = 'the turn failed'): string {
  const own = houseReason(err);
  if (own !== undefined) return own;
  if (!isMembraneError(err)) return otherwise;
  if (err.type === 'safety') return "the request couldn't be completed";
  const status = typeof err.httpStatus === 'number' ? `HTTP ${err.httpStatus}` : undefined;
  if (err.type === 'timeout') return `the model call timed out${status ? ` (${status})` : ''}`;
  const type = typeof err.type === 'string' ? boundFailureText(err.type, PROVIDER_ERROR_CODE_MAX_CHARS) : undefined;
  const parts = [type, status].filter((part): part is string => part !== undefined);
  return `the model call failed${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}
