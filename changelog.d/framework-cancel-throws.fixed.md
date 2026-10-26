- A cancel the framework makes whose stream's `cancel()` throws no longer
  leaves the framework's mark on that stream, which said a cancel had
  happened. At a context-budget restart, a tool result that ends the turn
  and a restart while the framework stops, the stream goes on, waiting for
  the round's results, which the boundary doesn't send: the turn keeps its
  token until the stream ends, a log line and an operator alert
  (`stream-cancel-failed`) say so, and a later `abortInference()` whose
  cancel goes through ends the turn as the caller's stop, with one
  `inference:aborted` carrying its reason. A restart whose cancel throws queues no continuation and reports
  no restart. After a restart's or an end of turn's failed cancel, that
  abort used to end with no `inference:aborted`, leaving the logical turn
  open, and after a failed restart-while-stopping cancel it was reported as
  `shutdown`. The tool boundary no longer throws into the event loop.
- `quiesce({ abandon: true })` resolves when a turn's stream's cancel
  throws, and goes on to the other agents' turns. It lists that agent in
  `unabandonable`, unless the turn waits at a check ahead, as in the
  tool-result guard's wait, where the abandon ends it instead; such a turn
  is listed only if it hasn't reached that check when the abandon's grace
  runs out. It used to
  reject with the cancel's error. `stop()` still rejects with such an
  error, now with a line naming the agent, and leaves a mark only for a
  cancel that happened, such as an abandon's before it.
- `Agent.cancelStream()` whose stream's `cancel()` throws leaves its record
  of a stop as it was before the call, so the stream's own later end, an
  `error` the provider reports included, isn't read as this stop.
- A turn's start whose compiled stream won't be sent (the framework
  stopping, a caller's stop during the compile, a provider wait recorded
  during it) ends as it does when the stream's cancel works, when that
  cancel throws. The stream was never iterated, so it sent nothing. It used
  to report `inference:failed` with the cancel's error instead.
- A stream that no longer owns its agent (a newer stream took it, or the
  agent was replaced or removed), whose `cancel()` throws, is logged, and
  the loop that drove it ends without rejecting its promise. It used to
  reject that promise, which went unhandled unless a `stop()` was waiting
  for that loop.
