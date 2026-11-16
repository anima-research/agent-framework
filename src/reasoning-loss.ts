/** #973: #938 stopped writing these notices, but old stores retain them.
 *  Exclude deterministically before selection, compression and thinking binding;
 *  never match text or change stored history. */
export function isReasoningLoss(metadata: unknown): boolean {
  const mark = metadata as { kind?: unknown; system?: unknown } | null | undefined;
  return mark?.kind === 'reasoning-loss' && mark.system === true;
}
