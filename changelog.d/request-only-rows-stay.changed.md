- A silent heartbeat tick's instruction now rides the tick's request-only
  separator instead of a system-position injection, so a tick's request
  carries the agent's own system prompt, like every other turn. A system
  prompt that changed for one turn cost the heartbeat's request its prompt
  cache from the system on, and on a provider that binds signed thinking to
  the prefix it was minted under (context-manager #155) it failed every
  retained thinking block in that request, and the tick reply's own thinking
  at the next ordinary turn. `SILENT_HEARTBEAT_SEPARATOR` is now that
  instruction, so every past tick reads it too: 199 characters where it was
  16, at each tick whose rows survive in the window (roughly 50 tokens a
  tick). The first compile after upgrading renders past ticks with the new
  text, one prompt-cache rewrite. (`InferenceRequest.ephemeralSystemPrompt`
  is removed; see the breaking entry.)
- When a compile ends on the agent's own message and the request gets a
  trailing `[Continue]` turn, the reply it prompts now has its first stored
  row marked `metadata.promptedBy: 'continue'`, and every later request
  renders `[Continue]` again just before that row, the way a silent tick's
  separator is rendered before its first row. Without it, later requests
  merged the reply into the previous assistant message (one message carrying
  signed thinking from two responses, a 400 when it is the latest), and
  dropped a turn the reply's request held, which a provider that binds
  thinking refuses. A reply with neither a tool call nor signed thinking
  can't be found in a compiled window and merges as before.
