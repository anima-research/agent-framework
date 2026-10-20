/**
 * Context injection is DEPRECATED — both sources:
 *
 *   - module `gatherContext()` (see `Module.gatherContext`), and
 *   - MCPL `context/beforeInference` `contextInjections` (spec §10.2).
 *
 * Injected blocks are per-compile overlays, never stored in the
 * conversation, so its record doesn't hold what the model saw. What else
 * they cost depends on the position:
 *
 *   - `beforeUser` / `afterUser`: re-anchored to the latest user-participant
 *     message on every compile. On the next activation the old block vanishes
 *     from its slot and reappears at the new tail, so the request diverges
 *     from every earlier one at that point. On providers whose prompt cache
 *     only hits boundaries an earlier request wrote (OpenAI Responses /
 *     Codex), the first call of every activation falls back to a head-only
 *     hit; on Anthropic the loss is bounded but real. A tool result travels
 *     in a user-participant message, so a mid-activation recompile (e.g. a
 *     stream retry) can anchor a `beforeUser` block between a tool call and
 *     its result; an `afterUser` block lands after the result.
 *   - `system`: appended to the system prompt on every request, never
 *     re-anchored, so it can't split a tool call from its result. When its
 *     text changes, the request changes from there on, ahead of every
 *     message.
 *
 * See anima-research/agent-framework#171.
 *
 * Behavior is unchanged for now — injections are still applied. Hosts log
 * one `[deprecated]` line per injecting module / server so remaining uses
 * are visible before the mechanism is removed.
 *
 * Instead: durable instructions belong in the agent's configured system
 * prompt, which the host's configuration sets; deliver time-varying state
 * as conversation content (push events, tool results) so it is stored once
 * at its own position and stays cache-stable.
 */

export const CONTEXT_INJECTION_DEPRECATION_NOTICE =
  'Context injection is deprecated (anima-research/agent-framework#171). An injected block is never' +
  " stored in the conversation, so its record doesn't hold what the model saw. A beforeUser or " +
  'afterUser block is re-anchored beside the latest user-participant message on every compile, ' +
  'which breaks prompt-cache prefixes (head-only hits on OpenAI lanes), and a beforeUser block can ' +
  'land between a tool call and its result. A system block is appended to the system prompt, so ' +
  'whenever its text changes, the request changes from there on, ahead of every message. Durable ' +
  "text belongs in the agent's configured system prompt, which whoever configures this host sets. " +
  'Moving changing state into conversation content (push events, tool results) is for whoever ' +
  'maintains the module or server named at the start of this line. Turning that module or server ' +
  'off removes its injections along with whatever else it does.';

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
    `[deprecated] ${who} returns context injections${detail ? ` (${detail})` : ''}, which still apply. ` +
      CONTEXT_INJECTION_DEPRECATION_NOTICE,
  );
}

/** Test-only: forget which sources have already been warned about. */
export function resetContextInjectionDeprecationWarnings(): void {
  warned.clear();
}
