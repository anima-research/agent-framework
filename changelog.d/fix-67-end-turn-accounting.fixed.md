- **A turn ended by a tool result (`endTurn`, such as `skip_reply`) is recorded as a completed
  turn** (#67). It emits `inference:completed` with the stream's cumulative usage, then
  `inference:turn_ended`, writes a successful inference-log entry (`stopReason: 'turn_ended'`),
  and adds its usage once to the session totals (`usage:updated`, `getSessionUsage()`). Like a
  completion, it resets the consecutive-failure streak and the poison-history rewind budget, ends
  a refusal-rewind episode (a forced `/unstick` reports that the model responded), and records a
  provider-cooldown recovery. In hosts such as connectome-host, consumers that end a turn's display
  on `inference:completed` (a typing indicator, notices that close on success, a voice relay) now
  end it on these turns too, and a consumer that totals `inference:completed`'s `tokenUsage` now
  counts them too; one that also adds each `inference:usage` sample counts them twice.
- **Every stream's billed rounds reach the session totals once, however the stream ends.** A
  context-budget or physical-window restart is counted and logged where it is decided
  (`stopReason: 'context_budget'` or `'physical_window'`), without `inference:completed`. A stream
  that errors, aborts or throws after finishing rounds counts them, and its failure entry in the
  inference log carries them. A stream superseded by a newer one, one whose agent was disposed,
  or one that ended with no final response and no other end, which wrote no entry before, now
  writes a failure entry naming what ended it and carrying its rounds, and `inferenceCount`
  counts it, when it had finished a round; one that hadn't has nothing to carry and writes none,
  as before. A stop of any other stream writes its own entry, which carries them. If the store
  fails while a stream's end is recorded, the error is reported on stderr and what comes after it
  still runs: the rest of a
  tool-ended turn's end, a restart's next stream, and the stream's teardown. Exactly one
  entry of each stream carries its usage, so totals summed from the inference log count each
  stream once, as the session's do. A health snapshot's token totals read the log's newest 1,000
  entries, so with these new entries that window spans fewer turns.
- An inference-log entry for a stream the framework ended at a tool boundary (a tool-ended turn or
  a restart) records a note in place of the compiled request, so these frequent entries don't each
  add a whole-context blob to the store. They are still new entries: the inference log keeps no
  retention, so it grows by one small entry for every tool-ended turn and restart, and by one
  entry, with its request, for each abandoned, superseded or disposed stream that had finished a
  round.
