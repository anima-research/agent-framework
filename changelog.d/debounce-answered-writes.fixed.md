- Debounced gate batches now omit events whose writes the recipient has already
  read and answered, using the scheduler's existing answered-request evidence.
  Fully satisfied batches add no gate line and start no turn; partial batches
  retain their unseen events. Failed or aborted requests do not consume a wake.
  Channel writes that require a reply are checked after final publication settles;
  judge, self-wake, sleep, and inference-status timing is unchanged.
- The exported `EventGate` class gains optional, internal-facing host integration:
  `evaluate(info, after)` accepts a `WritePlacement`, the constructor accepts
  `isWriteDone`, and `onInferenceEnded(agentName, repliesSettled)` can fence final
  publication. No new types are exported. Without these optional arguments,
  existing standalone gate behavior is unchanged.
