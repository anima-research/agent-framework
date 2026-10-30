/** `into.push(...items)` passes each item as a call argument, and V8 throws a
 *  RangeError past about 125,000 arguments, so this pushes them one at a
 *  time. */
export function appendAll<T>(into: T[], items: readonly T[]): void {
  for (let i = 0, n = items.length; i < n; i++) into.push(items[i]!);
}
