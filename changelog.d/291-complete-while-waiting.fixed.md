- When a stream completes while its round's tools still run, the round and its results are stored back to back, as
  at an ordinary tool boundary: each call still running gets an error result as before, the results are built first
  (a spilled result's workspace write included), and the round and its results are stored with no await between.
  Before, the round was stored ahead of the build and its results after it, so a write that landed meanwhile (another
  resident's own row in the shared slot, a module's `tool_result`, a channel's row in a fork) was stored between the
  round's `tool_use` and its result; it is now stored before both. While the results are built the round stays the
  agent's pending round (`getPendingAssistantRound`), and a child derived meanwhile (`deriveAgent`) is framed with
  the round and the results the agent holds: each that came in, and the error result of each call still running.
- A fork derived inside a tool call is handed the results already received (all of them while a tool boundary
  builds them for storing), with the note for the call that derived it and for any call still running, so it never
  meets a dangling `tool_use` (0.30.0's `pendingRound`, now carried onto the presentation index).
