- **Hosts that read an agent's watermarks, or queue wakes with `readsDeferredWrite` or `readsStoredMessage`:** an
  agent's read marks move to its window (#291).
  - `Agent.getConsumedWatermark()`, `getShownWatermark()` and `getAnsweredWatermark()` return an opaque `ReadMark`
    (exported, with `covers`, `coverTest`, `markAtOrAfter` and `describeReadMark`), not `{ branch, sequence }`: it
    keeps the store's head, as before, and the window's index length once the agent's context presents rows. Ask
    whether it covers a row with `covers(mark, agent.getContextManager(), row)`: `'covered'`, `'not-covered'`, or
    `'doubt'` for no mark or a mark on another branch. A mark taken while the window is the record covers a row by
    its own sequence, as `<=` did, so a host whose window is never written down gets the answers it got; once the
    window is written down, the same mark covers the rows the window held as of the mark, where they still stand,
    and not a row stored after it, taken out of the window, or presented again after it. (A `MarkCm` double without
    `getPresentedMessages` and `branchSequenceOf` is read by sequence.) `markAtOrAfter(a, b)` orders two marks on
    one branch by their index lengths where both keep one and they differ, and by the store's head otherwise.
    `markAnswered` and `notePublished` take a `ReadMark`, and `publishedAfterReading(destination, row, cm)` takes
    the row and the agent's context in place of a branch and a sequence.
  - `InferenceRequest.readsDeferredWrite` is renamed `readsRow`, and `readsStoredMessage` (0.28.0, #814) is folded
    into it: its value is the stored row the wake is for, where it was the deferred queue entry's id (the queue is
    gone), and a wake for a message stored as it arrived is judged as one for a row stored during the agent's turn
    (see Changed: what an agent has read is what its window held). The wake is dropped, as before, once an answered
    request covered the row (and, with a channel, the agent spoke there after), or once the row is gone.
  - `WritePlacement.messageId` names the stored row of every write stored at once, and `WritePlacement` gains
    `presented?: false` (a row stored and not presented to its agent: its turn was alive, or, at rest, its
    presentation at the write failed).

  **Migration:** compare marks through `covers` and `markAtOrAfter` instead of reading `.sequence`; rename
  `readsDeferredWrite` and `readsStoredMessage` to `readsRow`, and give it the stored id the write was answered.
