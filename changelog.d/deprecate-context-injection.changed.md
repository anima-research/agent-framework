- **Context injection is deprecated** — module `gatherContext()` and MCPL
  `context/beforeInference` `contextInjections` alike. Injected blocks are
  per-compile overlays that are never stored in the conversation. A
  `beforeUser` or `afterUser` block is placed beside the latest
  user-participant message, tool results included, on every compile, so it
  moves each time a newer one takes its place, which breaks prompt-cache
  prefixes at its old slot (on OpenAI Responses/Codex lanes the first call
  after such a move falls back to a head-only cache hit), and a `beforeUser`
  block placed beside a tool result lands between the tool call and its
  result in the compiled messages. With no user-participant message,
  context-manager 0.16 and later put both blocks at the end, and earlier
  versions drop a `beforeUser` block. A `system` block's text is appended to
  the system prompt, which comes before every message, so with a prefix
  cache each new text of it misses the cache for everything after it (#171).
  On a model that binds each signed thinking block to the request it was
  made in, a moved block or new `system` text also means no reply after the
  point where the request first changed can keep its thinking. Nothing is
  removed for now, and the deprecation changes nothing about how injections
  are applied: each module and MCPL server whose injections the host collects
  is named in one `[deprecated]` line, and a server whose injections the
  feature-set and grant checks all drop isn't named. An MCPL server's
  config can stop its injections alone, keeping the rest of what it does,
  with `disabledCapabilities: ["contextHooks.beforeInference.inject"]`. The
  framework's own `system` injections aren't logged: the subconscious's
  standing dispositions and, before 0.23.0, a silent heartbeat's
  `ephemeralSystemPrompt`. `Module.gatherContext`,
  `Module.contextTimeoutMs` and `BeforeInferenceResult.contextInjections`
  carry `@deprecated`. Deliver changing state as conversation content
  (events, push events, tool results) instead. Durable content belongs in
  the agent's configured system prompt, which the host's configuration sets
  and which is fixed once the agent is made, so `system` text that changes
  at runtime has no provider-independent replacement (with membrane 0.7 and
  context-manager 0.22 and later, a stored `system_change` block adds system
  text from its place in the conversation, through membrane's native
  formatter and Anthropic adapter only, to a model that takes
  mid-conversation system messages).
