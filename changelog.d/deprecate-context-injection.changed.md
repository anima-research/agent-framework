- **Context injection is deprecated** — module `gatherContext()` and MCPL
  `context/beforeInference` `contextInjections` alike. Injected blocks are
  per-compile overlays that are never stored in the conversation. A
  `beforeUser` or `afterUser` block is placed beside the latest
  user-participant message, tool results included, on every compile, so it
  moves each time a newer one takes its place, which breaks prompt-cache
  prefixes at its old slot (on OpenAI Responses/Codex lanes the first call
  after such a move falls back to a head-only cache hit), and a `beforeUser`
  block placed beside a tool result lands between the tool call and its
  result. With no user-participant message, context-manager before 0.16
  drops a `beforeUser` block. A `system` block's text is appended to the
  system prompt, which comes before every message, so with a prefix cache
  each new text of it misses the cache for everything after it (#171).
  Nothing is removed for now, and the deprecation changes nothing about how
  injections are applied: the host logs one `[deprecated]` line per module or
  MCPL server the first time its injections are gathered in time for a turn.
  `Module.gatherContext`, `Module.contextTimeoutMs` and
  `BeforeInferenceResult.contextInjections` carry `@deprecated`. Durable
  content belongs in the agent's configured system prompt, which the host's
  configuration sets; deliver changing state as conversation content (events,
  push events, tool results) instead.
