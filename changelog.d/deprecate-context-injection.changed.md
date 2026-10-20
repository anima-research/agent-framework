- **Context injection is deprecated** — module `gatherContext()` and MCPL
  `context/beforeInference` `contextInjections` alike. Injected blocks are
  per-compile overlays that are never stored in the conversation. A
  `beforeUser` or `afterUser` block is re-anchored to the latest
  user-participant message on every compile, so it breaks prompt-cache
  prefixes across activations (on OpenAI Responses/Codex lanes the first call
  of every activation falls back to a head-only cache hit), and after a
  mid-activation recompile a `beforeUser` block can land between a tool call
  and its result. A `system` block is appended to the system prompt, so
  whenever its text changes, the request changes from there on, ahead of every
  message (#171). Behavior is unchanged for now: injections still apply, and
  the host logs one `[deprecated]` line per module or MCPL server the first
  time it injects. `Module.gatherContext`, `Module.contextTimeoutMs` and
  `BeforeInferenceResult.contextInjections` carry `@deprecated`. Durable
  content belongs in the agent's configured system prompt, which the host's
  configuration sets; deliver changing state as conversation content (events,
  push events, tool results) instead.
