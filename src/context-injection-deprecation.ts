/** A `beforeUser` context injection is deprecated (anima-research/agent-framework#171). */

const NOTICE =
  'Placing a context injection at beforeUser is deprecated (anima-research/agent-framework#171). ' +
  'It is placed again at every compile before the newest user message, or at the window\'s end where there ' +
  'is none, so it moves whenever that place does: the request misses the cache from there on, and it can ' +
  'split a tool call from its result. Use afterUser, which is stored where it lands, unless a module sets placedEachCompile on it.';

/** The line logged for a module or MCPL server whose collected injections include a `beforeUser` one. */
export function beforeUserDeprecationLine(kind: 'module' | 'mcpl-server', id: string): string {
  const who = kind === 'module' ? `module "${id}"` : `MCPL server "${id}"`;
  return `[deprecated] ${who} places a context injection at beforeUser, which still works. ${NOTICE}`;
}
