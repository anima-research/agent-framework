/** A `beforeUser` context injection is deprecated (anima-research/agent-framework#171). */

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
