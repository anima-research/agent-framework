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
 *   - `beforeUser` / `afterUser`: placed beside the latest message whose
 *     participant is `user` in any letter case, as tool results are stored,
 *     wherever that message is in the history, again on every compile. When
 *     a later message takes its place, the old block vanishes from its slot
 *     and reappears beside the new one, so the request diverges from every
 *     earlier one at the old slot. On providers whose prompt cache only hits
 *     boundaries an earlier request wrote (OpenAI Responses / Codex), the
 *     first call after such a move falls back to a head-only hit; on
 *     Anthropic the loss is bounded but real. A `beforeUser` block placed
 *     beside a tool result lands between the tool call and its result; an
 *     `afterUser` block lands after the result. With no `user` message,
 *     context-manager before 0.16 drops a `beforeUser` block and puts an
 *     `afterUser` one at the end.
 *   - `system`: its text is appended to the system prompt on every request,
 *     never re-anchored, so it can't split a tool call from its result.
 *     Blocks that aren't text can't be carried there. The system prompt
 *     comes before every message, so with a prefix cache each new text of
 *     that block misses the cache for everything after it in the request.
 *
 * See anima-research/agent-framework#171.
 *
 * Nothing is removed yet, and the deprecation changes nothing about how
 * injections are applied. Hosts log one `[deprecated]` line per module /
 * server whose injections are gathered in time for a turn, so remaining uses
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
  'afterUser block is placed beside the latest user-participant message, tool results included, ' +
  'on every compile, so it moves each time a newer one takes its place, which breaks prompt-cache ' +
  'prefixes at its old slot (head-only hits on OpenAI lanes), and a beforeUser block placed beside ' +
  'a tool result lands between the tool call and its result; with no user-participant message, ' +
  'context-manager before 0.16 drops a beforeUser block. A system block\'s text is appended to the ' +
  'system prompt, which comes before every message, so with a prefix cache each new text of it ' +
  'misses the cache for everything after it. Durable ' +
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
): void {
  const key = `${kind}:${id}`;
  if (warned.has(key)) return;
  warned.add(key);
  const who = kind === 'module' ? `module "${id}"` : `MCPL server "${id}"`;
  console.warn(
    `[deprecated] ${who} returns context injections, and this line changes nothing about how ` +
      "they're applied. " +
      CONTEXT_INJECTION_DEPRECATION_NOTICE,
  );
}

/** Test-only: forget which sources have already been warned about. */
export function resetContextInjectionDeprecationWarnings(): void {
  warned.clear();
}
