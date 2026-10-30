- The exported `EventGate` class gains optional, internal-facing host integration:
  `evaluate(info, after)` accepts a `WritePlacement`, the constructor accepts
  `isWriteDone`, and `onInferenceEnded(agentName, repliesSettled)` can fence final
  publication. No new types are exported. Without these optional arguments,
  existing standalone gate behavior is unchanged.
- Optional `getSharedSlotReaders()` host integration identifies the shared
  message slot; isolated recipients get a line in their own window. Shared
  summaries omit divergent answered events rather than re-present them to
  other readers; their original stored content and unread recipients' wakes
  remain. Without this hook, legacy batch-line placement is unchanged.
