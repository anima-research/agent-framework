/**
 * The names someone most likely meant, when the one they gave matches none:
 * for a refusal's "did you mean", such as a tool name an agent got wrong.
 *
 * Case is ignored. A candidate that the name matches as a whole `--` segment
 * ("ls" for "workspace--ls"), then one that starts with it or that it starts
 * with, then one that contains it or that it contains, ranks ahead of one
 * that is only a few edits away, however many edits those matches take. The
 * prefix and substring matches need three characters on the shorter side,
 * since a letter or two is in nearly every name. A candidate that matches in
 * none of those ways counts only within the edits noiseLimit allows, and past
 * that it's noise. So a name that is part of no candidate, holds none and is
 * close to none gets nothing back, and a name in a crowded namespace doesn't
 * get its neighbours (`workspace--write` for `workspace--read`).
 */
export function closestNames(name: string, candidates: readonly string[], max = 2): string[] {
  const wanted = name.toLowerCase();
  const ranked: { candidate: string; tier: number; distance: number }[] = [];
  for (const candidate of new Set(candidates)) {
    const other = candidate.toLowerCase();
    const shorter = Math.min(wanted.length, other.length);
    const tier = other === wanted ? 0
      : wanted && other.split('--').includes(wanted) ? 1
      : shorter >= 3 && (other.startsWith(wanted) || wanted.startsWith(other)) ? 2
      : shorter >= 3 && (other.includes(wanted) || wanted.includes(other)) ? 3
      : 4;
    // In tiers 0 to 3 one name holds the other, so the length difference is
    // already their distance, and a long name skips the edit table.
    const limit = tier === 4 ? noiseLimit(wanted, other) : Infinity;
    const distance = tier === 4 ? editDistance(wanted, other, limit) : Math.abs(wanted.length - other.length);
    if (distance > limit) continue;
    ranked.push({ candidate, tier, distance });
  }
  // A stable sort: candidates that tie keep the order they were given in.
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance);
  return ranked.slice(0, Math.max(0, max)).map((entry) => entry.candidate);
}

/**
 * Whether `name` looks like a slip for `candidate`, ignoring case: the same;
 * a few edits apart, where a transposition counts as one edit; or, at three
 * characters or more, a part of it, which is a shortened attempt at it
 * (`mode` for `deliveryMode`, `interval` for `refillIntervalMs`). A part
 * counts only that way round: a name that holds the candidate, and is more
 * edits from it than a slip allows, is another name, usually an extra that
 * explains it (`channel_note` beside `channel`, where `channels` is a slip).
 * Beyond these, two names are different names rather than one mistyped.
 */
export function isNearMiss(name: string, candidate: string): boolean {
  const a = name.toLowerCase(), b = candidate.toLowerCase();
  if (a.length >= 3 && b.includes(a)) return true;
  const limit = noiseLimit(a, b);
  return editDistance(a, b, limit) <= limit;
}

/**
 * The most edits that still read as a slip: a quarter of what follows the
 * prefix the two names share, and at least one. A shared prefix is mostly a
 * namespace (`workspace--`, `mcpl--discord--`) and says nothing about the
 * rest, so `workspace--read` and `workspace--write` are four edits apart in
 * a four-letter tool name, not in a fifteen-letter one.
 */
function noiseLimit(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return Math.max(1, Math.floor((Math.max(a.length, b.length) - shared) / 4));
}

/**
 * Edits between two strings: insertions, deletions, substitutions and
 * swaps of neighbours (optimal string alignment). Past `limit` the exact
 * count doesn't matter, so it answers `limit + 1` as soon as it is sure.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    // No row's smallest entry is below the one before it, so none later can come back under the limit.
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}
