- A silent heartbeat tick's instruction now rides the tick's request-only
  separator instead of a system-position injection, so a tick's request
  carries the agent's own system prompt, like every other turn. A system
  prompt that changed for one turn cost the heartbeat's request its prompt
  cache from the system on, and on a provider that binds signed thinking to
  the prefix it was minted under (context-manager #155) it failed every
  retained thinking block in that request, and the tick reply's own thinking
  at the next ordinary turn. `SILENT_HEARTBEAT_SEPARATOR` is now that
  instruction (199 characters where it was 16, roughly 50 tokens at each
  tick whose rows survive in the window). Each tick's rows now record the
  separator their request rendered (`SilentHeartbeatStamp.separator`), and
  later compiles render that text, so ticks stored before upgrading keep
  their `[heartbeat tick]` marker byte for byte: no stored reply's prefix
  changes. (`InferenceRequest.ephemeralSystemPrompt` is removed; see the
  breaking entry.)
- A tick whose restart compiles none of the tick's rows (a strategy folded
  them all) opens again: the restart's request ends on the separator, where
  later compiles render it before the restart's reply. It used to end on
  `[Continue]`, and later compiles put the separator before a reply whose
  request never held it.
- When a compile ends on the agent's own message and the request gets a
  trailing `[Continue]` turn, every row the reply's turn stores now records
  that prompt (`metadata.promptedBy`, a `{ turn, text }` pair), and every
  later request renders `[Continue]` again just before the first of them
  that survives, the way a silent tick's separator is rendered. A restart or
  retry of the turn keeps the prompt only while its own request renders it.
  Without it, later requests merged the reply into the previous assistant
  message (one message carrying signed thinking from two responses, a 400
  when it is the latest), and dropped a turn the reply's request held, which
  a provider that binds thinking refuses. A reply with neither a tool call
  nor signed thinking can't be found in a compiled window and merges as
  before. `StartStreamResult.continuePrompt` and
  `InferenceRequest.continuePrompt` carry it (new, optional); the agent and
  the framework set them.
