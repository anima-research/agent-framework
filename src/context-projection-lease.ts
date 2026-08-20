import type { CompileResult } from '@animalabs/context-manager';

interface ProjectionStats {
  total: { messages: number };
  head: { messages: number };
  tail: { messages: number };
}

/**
 * Reversible provider-facing compatibility lease for one named resident.
 * Chronicle and ContextManager selection remain untouched. Only the compiled
 * request omits the middle region; context injections remain in their original
 * relative positions.
 */
export function applyHeadTailProjectionLease(
  result: CompileResult,
  stats: ProjectionStats,
  agentName: string,
  leasedAgent: string | undefined,
): CompileResult {
  if (!leasedAgent || leasedAgent !== agentName) return result;

  const total = stats.total.messages;
  const head = stats.head.messages;
  const tail = stats.tail.messages;
  if (![total, head, tail].every(Number.isSafeInteger) || total < 0 || head < 0 || tail < 0 || head + tail > total) {
    throw new Error(`Invalid head/tail projection stats: total=${total} head=${head} tail=${tail}`);
  }

  let baseIndex = 0;
  const messages = result.messages.filter((message) => {
    if (message.participant.startsWith('injection:')) return true;
    const keep = baseIndex < head || baseIndex >= total - tail;
    baseIndex += 1;
    return keep;
  });
  if (baseIndex !== total) {
    throw new Error(`Head/tail projection base-count mismatch: rendered=${baseIndex} stats=${total}`);
  }
  return { ...result, messages };
}
