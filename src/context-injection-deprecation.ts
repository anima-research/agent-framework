/**
 * Context injection is DEPRECATED — both sources:
 *
 *   - module `gatherContext()` (see `Module.gatherContext`), and
 *   - MCPL `context/beforeInference` `contextInjections` (spec §10.2).
 *
 * Injected blocks are per-compile overlays: never stored, and re-anchored to
 * the latest user-participant message on every compile. On the next
 * activation the old block vanishes from its slot and reappears at the new
 * tail, so the request diverges from every earlier one at that point. On
 * providers whose prompt cache only hits boundaries an earlier request
 * wrote (OpenAI Responses / Codex), the first call of every activation falls
 * back to a head-only hit; on Anthropic the loss is bounded but real. A
 * mid-activation recompile (e.g. a stream retry) can also anchor the block
 * between a tool call and its result. See anima-research/agent-framework#171.
 *
 * Behavior is unchanged for now — injections are still applied. Hosts log
 * one `[deprecated]` line per injecting module / server so remaining uses
 * are visible before the mechanism is removed.
 *
 * Instead: put durable instructions in the system prompt; deliver
 * time-varying state as conversation content (push events, tool results)
 * so it is stored once at its own position and stays cache-stable.
 */

export const CONTEXT_INJECTION_DEPRECATION_NOTICE =
  'Context injection is deprecated: injected blocks are per-compile overlays that are never ' +
  'stored and are re-anchored on every activation, which breaks prompt-cache prefixes ' +
  '(head-only hits on OpenAI lanes) and can land between a tool call and its result. ' +
  'Put durable content in the system prompt and deliver changing state as conversation ' +
  'content (push events, tool results) instead. See anima-research/agent-framework#171.';

const warned = new Set<string>();

/**
 * Log the deprecation once per (kind, id) for the life of the process.
 * Call it only when the source actually produced at least one injection.
 */
export function warnContextInjectionDeprecated(
  kind: 'module' | 'mcpl-server',
  id: string,
  detail?: string,
): void {
  const key = `${kind}:${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  const who = kind === 'module' ? `module "${id}"` : `MCPL server "${id}"`;
  console.warn(
    `[deprecated] ${who} injected context${detail ? ` (${detail})` : ''}. ` +
      CONTEXT_INJECTION_DEPRECATION_NOTICE,
  );
}

/** Test-only: forget which sources have already been warned about. */
export function resetContextInjectionDeprecationWarnings(): void {
  warned.clear();
}
