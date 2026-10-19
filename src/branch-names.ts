/**
 * A name for a new branch: `base` when `taken(base)` is false, else the first
 * of `base-2`, `base-3`, … that isn't taken.
 *
 * Default operator branch names carry the time in milliseconds
 * (`suppress/<agent>/<ts>`, `rollback/<agent>/<ts>`, …), so a second change of
 * one kind made right after the first, in the same millisecond, would
 * otherwise get the first one's name and be refused. Callers pass what counts
 * as taken, at least every branch the store holds: the store knows every
 * branch, whatever made it, where a counter kept in the process would know
 * only the names it gave out.
 */
export function firstFreeBranchName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`;
    if (!taken(name)) return name;
  }
}
