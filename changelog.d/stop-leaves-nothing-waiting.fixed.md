- `stop()` now ends every ephemeral run still registered once its event
  loop has ended, with "refused: the framework is stopping", such as a run
  whose wake the loop hadn't taken up when `stop()` began, whose turn
  `stop()` refused, or whose retry it cancelled. Before, such a run waited
  for its startup watchdog (30 s by default) or, once its inference had
  started, its idle watchdog (15 minutes by default) before it rejected. A
  run's startup or idle watchdog that fires once `stop()` has begun,
  before that end, now rejects with the same error followed by what it
  saw, such as "(inference not started within 30000ms)". Before, it named
  a stalled event loop or a lost stream as the cause, even for a run whose
  turn `stop()` had refused.
- After a `stop()` that cancelled a turn's retry, a `start()` on the same
  framework (one whose store it doesn't own, or whose `stop()` failed)
  delivers the event gate's debounced batches again. The cancelled turn
  left its agent inferring at the gate, so every batch was buffered, and
  woke no agent, until that agent's next turn ended.
  `EventGate.dispose()`, which `stop()` calls once its streams and event
  loop have ended, now clears which agents are inferring. A turn that
  continues another, such as a budget restart left queued that a `start()`
  takes up, marks its agent inferring again through the new
  `EventGate.onInferenceResumed()`, which, unlike `onInferenceStarted()`,
  leaves a pending self-wake alone.
- A budget restart or tool-result-guard retry that a provider hold kept
  from starting, such as a stated wait or an acceleration cooldown, now
  marks its agent inferring at the event gate when it runs after the hold,
  as any turn that runs does, so debounced batches wait for its end.
  Before, the hold ended its turn at the gate, and it ran without it:
  unless another agent was inferring, the gate delivered debounced batches
  while it ran, into the message slot residents share.
- A turn whose retry `stop()` cancels now ends with `inference:aborted`
  after its `inference:failed`, with the reason "a retry waiting while the
  framework was stopping is dropped before it sends anything", and
  `healthSnapshot()`'s `lastInference` records its end. Before, nothing
  followed that event, and for a turn whose stream couldn't start,
  `lastInference` had no end.
