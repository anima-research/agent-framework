- **Code that sets or reads `InferenceRequest.ephemeralSystemPrompt`:** the
  field is removed. It carried a system-position prompt for one turn; the
  silent heartbeat was its only producer, and its instruction now rides the
  tick's request-only separator. There is no replacement: a system prompt
  that changes for one turn costs that request its prompt cache from the
  system on, and changes what every retained signed-thinking block is bound
  to. Nothing in this package or in connectome-host sets or reads it.
  Unchanged: `suppressProse` and `silentHeartbeat` on `InferenceRequest`.
