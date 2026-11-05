import type { CompileResult, ContextManager } from '@animalabs/context-manager';

/** Render-only compatibility for #973: #938 stopped writing these notices,
 *  but old stores still contain them. Use raw provenance, never their text;
 *  keep selection and cache breakpoints on every preceding row unchanged.
 *  Seeds must apply this before copying content without its metadata. */
export function reasoningLossRows(result: CompileResult, contextManager: ContextManager): Set<number> {
  const omitted = new Set<number>();
  if (!result.provenance || typeof contextManager.getAllMessages !== 'function') return omitted;
  const notices = new Set(contextManager.getAllMessages()
    .filter(({ metadata }) => metadata?.kind === 'reasoning-loss' && metadata.system === true)
    .map(({ id }) => id));
  result.provenance.messages.forEach((source, i) => {
    if (source.kind === 'raw' && source.bodies.length > 0
      && source.bodies.every(({ messageId }) => notices.has(messageId))) omitted.add(i);
  });
  return omitted;
}
