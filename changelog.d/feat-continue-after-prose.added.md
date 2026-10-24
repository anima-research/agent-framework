- **Hosts:** `AgentConfig.autoContinue` (default off): a turn the model ends
  itself, with prose or with nothing, is followed by another turn straight
  away, until the agent calls `skip_reply` (or another tool that ends the
  turn), ends on a `>>skip_reply` / `>>>skip_reply` envelope, or reaches
  `maxConsecutive` continuations in a row (default 3, 1 to 20). The count
  starts again on any wake with a cause of its own (a silent heartbeat tick
  isn't one). As the next turn starts it reads a short `[continue]` row
  naming the agent, saying another turn starts, how to stop and that
  unmarked words are sent as usual (and, on the last continuation, that it
  waits for the next event after it); the row is written only when the
  continuation is that turn's whole cause, never for a wake that doesn't run.
  The next turn keeps the turn's locus unless a batched message names
  another channel. Its wake has reason `auto-continue`. Not continued:
  refusals, `max_tokens` cut-offs, the stall guard's ends, silent heartbeat
  ticks, a turn whose closing prose bounced, ephemeral runs, conversation forks, an
  agent offered no way to stop, and a quiesce (which drops a queued
  continuation); a ` !` continuation runs instead. Each continuation is a
  full inference: an agent that answers and ends its turn gets at least one
  more per answer. A malformed setting is refused when the agent is built,
  naming the value's kind, never the value. New exported types
  `AutoContinueConfig` and `AutoContinueRun` (`InferenceRequest.autoContinueRun`).
  See docs/auto-continue.md.
