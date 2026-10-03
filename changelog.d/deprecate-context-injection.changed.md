- **Context injection is deprecated** — module `gatherContext()` and MCPL
  `context/beforeInference` `contextInjections` alike. Injected blocks are
  per-compile overlays that are never stored and are re-anchored to the latest
  user message on every compile, so they break prompt-cache prefixes across
  activations (on OpenAI Responses/Codex lanes the first call of every
  activation falls back to a head-only cache hit) and can land between a tool
  call and its result after a mid-activation recompile (#171). Behavior is
  unchanged for now: injections still apply, and the host logs one
  `[deprecated]` line per module or MCPL server the first time it injects.
  `Module.gatherContext`, `Module.contextTimeoutMs` and
  `BeforeInferenceResult.contextInjections` carry `@deprecated`. Put durable
  content in the system prompt and deliver changing state as conversation
  content (events, push events, tool results) instead.
