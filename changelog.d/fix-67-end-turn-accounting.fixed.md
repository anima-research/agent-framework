- **A turn ended by a tool result (`endTurn`, such as `skip_reply`) is recorded as a completed
  turn** (#67). It emits `inference:completed` with the stream's cumulative usage, then
  `inference:turn_ended`, writes a successful inference-log entry (`stopReason: 'turn_ended'`),
  and adds its usage once to the session totals (`usage:updated`, `getSessionUsage()`). Like a
  completion, it resets the consecutive-failure streak and the poison-history rewind budget, ends
  a refusal-rewind episode (a forced `/unstick` reports that the model responded), and records a
  provider-cooldown recovery. Consumers that end a turn's display on `inference:completed`, such as
  typing indicators, voice relays and alerts that close on success, now end it on these turns too.
- **Every stream's billed rounds reach the session totals once, however the stream ends.** A
  context-budget or physical-window restart is counted and logged where it is decided
  (`stopReason: 'context_budget'` or `'physical_window'`), without `inference:completed`. A stream
  that errors, aborts or throws after finishing rounds counts them, and its failure entry in the
  inference log carries them. `inferenceCount` counts these streams too, and log-backed health
  totals include them.
- An inference-log entry for a stream the framework ended at a tool boundary (a tool-ended turn or
  a restart) records a note in place of the compiled request, so these frequent entries don't each
  add a whole-context blob to the store.
