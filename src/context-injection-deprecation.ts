/**
 * Placing a context injection at `beforeUser` is deprecated
 * (anima-research/agent-framework#171), from a module's `gatherContext()` and
 * from an MCPL server's `context/beforeInference` alike. `compile()` places it
 * again before the newest user message at every compile, so it moves: the
 * request misses the cache from there on, and it can split a tool call from
 * its result, since tool results are stored as user messages. Use
 * `afterUser`, which is stored where it lands (stored-injections.ts).
 *
 * The other positions stay supported:
 *
 *   - A `system` injection goes into the system prompt. A change to its text
 *     misses the cache from the system prompt on, and the conversation
 *     doesn't store it.
 *   - An `afterUser` injection a module sets `placedEachCompile` on is placed
 *     again at each start, so it moves, with the same cache cost as
 *     `beforeUser`, and on a model that binds a reply's thinking to
 *     everything before it, every reply after its old place loses its
 *     thinking. It's for text that must stay near the end, such as
 *     instructions.
 *
 * Nothing changes in how injections are applied. Each module and MCPL server
 * whose collected injections include a `beforeUser` one is named once on
 * stderr, so remaining uses are visible.
 */

export const CONTEXT_INJECTION_DEPRECATION_NOTICE =
  'Placing a context injection at beforeUser is deprecated (anima-research/agent-framework#171). ' +
  'It is placed again before the newest user message at every compile, so it moves: the request misses ' +
  'the cache from there on, and it can split a tool call from its result. Use afterUser, which is stored ' +
  'where it lands.';

const warned = new Set<string>();

/**
 * Log the deprecation once per (kind, id) for the life of the process.
 * Call it only when the source's collected injections include a
 * `beforeUser` one.
 */
export function warnContextInjectionDeprecated(
  kind: 'module' | 'mcpl-server',
  id: string,
): void {
  const key = `${kind}:${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  const who = kind === 'module' ? `module "${id}"` : `MCPL server "${id}"`;
  console.warn(
    `[deprecated] ${who} places a context injection at beforeUser, which is still applied. ` +
      CONTEXT_INJECTION_DEPRECATION_NOTICE,
  );
}

/** Test-only: forget which sources have already been warned about. */
export function resetContextInjectionDeprecationWarnings(): void {
  warned.clear();
}
