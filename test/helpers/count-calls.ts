/**
 * Counts the calls `run` makes to one method, such as `String.prototype.indexOf`,
 * that `counted` picks, and restores the method once `run` ends, however it
 * ends. A counted call past `ceiling` throws, so code that makes far more such
 * calls than a test allows fails on the count at once, rather than after the
 * work the count stands for. `run` is synchronous: the method is restored as
 * it returns, so a promise's later work would go uncounted, and one it returns
 * is refused.
 */
export function countingCalls<R>(
  owner: object,
  name: string,
  counted: (args: unknown[]) => boolean,
  ceiling: number,
  run: () => R,
): { result: R; calls: number } {
  const slot = owner as Record<string, unknown>;
  const original = slot[name] as (this: unknown, ...args: unknown[]) => unknown;
  let calls = 0;
  slot[name] = function (this: unknown, ...args: unknown[]): unknown {
    if (counted(args) && ++calls > ceiling) throw new Error(`${name} was called more than ${ceiling} times where counted`);
    return original.apply(this, args);
  };
  try {
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === 'function') throw new Error(`countingCalls counts a synchronous call; run returned a promise, whose later calls to ${name} would go uncounted`);
    return { result, calls };
  } finally {
    slot[name] = original;
  }
}
