- The exported `EventGate` class gains optional, internal-facing host integration:
  `evaluate(info, after)` accepts a `WritePlacement`, the constructor accepts
  `isWriteDone`, and `onInferenceEnded(agentName, repliesSettled)` can fence final
  publication. No new types are exported. Without these optional arguments,
  existing standalone gate behavior is unchanged.
