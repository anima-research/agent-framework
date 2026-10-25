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
 *     beside a tool result lands between the tool call and its result in
 *     the compiled messages; membrane's native formatter then moves the
 *     result ahead of it, into the same message, and its OpenAI Responses
 *     formatter sends it between the call and its output. An `afterUser`
 *     block lands after the result. With no `user` message, context-manager
 *     0.16 and later put both blocks at the end, `beforeUser` first, and
 *     earlier versions drop a `beforeUser` block and put an `afterUser` one
 *     at the end.
 *   - `system`: its text is appended to the system prompt on every request,
 *     never re-anchored, so it can't split a tool call from its result.
 *     Blocks that aren't text can't be carried there. The system prompt
 *     comes before every message, so with a prefix cache each new text of
 *     that block misses the cache for everything after it in the request.
 *
 * On a model that binds each signed thinking block to the request it was
 * made in, a block that moves, or new text in a `system` block, also means
 * no reply after the point where the request first changed can keep its
 * thinking. As context-manager 0.22's thinking binding describes it, such a
 * provider refuses the request or sets that thinking aside. With
 * context-manager 0.22 and later, where the agent tells it that its model
 * binds (`thinkingBinding.binds`), the compile leaves that thinking out
 * instead.
 *
 * See anima-research/agent-framework#171.
 *
 * Nothing is removed yet, and the deprecation changes nothing about how
 * injections are applied. Each module and MCPL server whose injections the
 * host collects (adds to the list the module registry or the MCPL hook
 * returns) is named in one `[deprecated]` line, so remaining uses are
 * visible before the mechanism is removed. A module that returns none isn't
 * named, and nor is a server whose injections the feature-set and grant
 * checks all drop. The framework's own `system` injections pass through
 * neither the registry nor the hook, so they aren't logged: the
 * subconscious's standing dispositions and, before 0.23.0, a silent
 * heartbeat's `ephemeralSystemPrompt`.
 *
 * Whoever configures the host can stop one MCPL server's injections with
 * `disabledCapabilities: ["contextHooks.beforeInference.inject"]` in its
 * config. The server's other capabilities stay granted, but any feature set
 * of its whose `uses` names an inject capability is disabled at the
 * handshake, with a stderr line, and so is whatever else that feature set
 * does, such as its push events. An injection the server still sends is
 * dropped, with a stderr line for each, or without one when it comes under a
 * disabled feature set. A server's `system` injections are denied by
 * default, so they arrive only if its config's `enabledCapabilities` grants
 * them. A module has no such switch.
 *
 * Instead: deliver changing state as conversation content (push events,
 * tool results), so it is stored once at its own position and stays
 * cache-stable. Durable instructions belong in the agent's configured system
 * prompt, which the host's configuration sets. That prompt is fixed once the
 * agent is made, so `system` text that changes at runtime has no
 * provider-independent replacement. With membrane 0.7 and context-manager
 * 0.22 and later, a stored message holding only a `system_change` block adds
 * its `addSystem` text as a system message at the first point at or after
 * its place that follows a user turn, and leaves the messages before it as
 * they were. Only membrane's native formatter sends one, through an adapter
 * that declares it can (of membrane's own, the Anthropic adapter), and
 * membrane refuses the request through any other formatter or adapter. Even
 * there, membrane refuses a request with no such point, as when the change
 * follows the final assistant message, and, as membrane's docs say, the API
 * refuses one to a model that doesn't take mid-conversation system messages.
 * It adds text, and can't take back or replace any.
 */

export const CONTEXT_INJECTION_DEPRECATION_NOTICE =
  'Context injection is deprecated (anima-research/agent-framework#171). Moving changing state ' +
  'into conversation content (push events, tool results) is for whoever maintains the module or ' +
  "server named at the start of this line. Durable system text belongs in the agent's configured " +
  'system prompt, which whoever configures this host sets; system text that changes at runtime ' +
  'has no provider-independent replacement. For an MCPL server, disabledCapabilities: ' +
  '["contextHooks.beforeInference.inject"] in its config drops its injections and any feature set of ' +
  'its that uses them, and keeps its other capabilities; its system injections are denied unless its ' +
  'config enables them. A module has no such switch: turning it off removes its injections along ' +
  'with whatever else it does.';

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
