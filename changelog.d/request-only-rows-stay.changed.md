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
  trailing `[Continue]` turn, the reply's rows (its assistant responses and
  tool results) now record that prompt (`metadata.promptedBy`, a
  `{ turn, text }` pair), and every later request renders `[Continue]`
  again just before the first of its assistant rows that survives, the way a
  silent tick's separator is rendered. A later reply follows the same prompt
  when what it is sent ends on the tool results of a reply that did: a next
  round of the stream, a budget restart, an error retry, or a new process
  reading the stored rows. A reply sent anything else after those results,
  such as a message that arrived at the tool boundary or during a provider
  cooldown, follows that instead and records no prompt. Without the turn,
  later requests merged the reply into the previous assistant message (one
  message carrying signed thinking from two responses, a 400 when it is the
  latest), and dropped a turn the reply's request held, which a provider
  that binds thinking refuses. A reply with neither a tool call nor signed or
  redacted thinking can't be found in a compiled window and merges as
  before. `StartStreamResult.continuePrompt` carries the prompt a stream's
  request ends on (new, optional); the agent sets it. The direct
  `runInference` paths compile without these request-only turns, as they
  did without the tick separator, so their replies render none.
