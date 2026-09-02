/** Convert a cumulative usage counter into the contribution of this call.
 * A counter reset (provider/stream implementation change) is treated as an
 * already-per-call sample rather than producing a negative value. */
export function cumulativeDelta(current: number, previous: number): number {
  if (!Number.isFinite(current) || current < 0) return 0;
  if (!Number.isFinite(previous) || previous < 0 || current < previous) return current;
  return current - previous;
}
