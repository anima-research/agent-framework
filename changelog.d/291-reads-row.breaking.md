- **Hosts that read an agent's watermarks, or queue wakes with
  `readsDeferredWrite`:** an agent's read marks move to its window (#291).
  - `Agent.getConsumedWatermark()`, `getShownWatermark()` and
    `getAnsweredWatermark()` return a `ReadMark` (exported, with `covers`,
    `coverTest`, `markAtOrAfter` and `describeReadMark`), not
    `{ branch, sequence }`. The mark is opaque: it keeps the store's head,
    as before, and the window's index length once the agent's context
    presents rows (context-manager's presented mode). Ask whether it covers
    a row with `covers(mark, agent.getContextManager(), row)`: `'covered'`,
    `'not-covered'`, or `'doubt'` for no mark or a mark on another branch.
    A mark taken in legacy mode covers a row by its own sequence, as `<=`
    did, so a host that never presents gets the answers it got.
    `markAnswered` and `notePublished` take a `ReadMark`, and
    `publishedAfterReading(destination, row, cm)` takes the row and the
    agent's context in place of a branch and a sequence.
  - `InferenceRequest.readsDeferredWrite` is renamed `readsRow`. Its value
    is the stored row the wake is for, or, while the write still waits in
    the framework's deferred queue, its held handle (`held:` and the queue
    entry's id), where it was the bare entry id. The wake is dropped, as
    before, once an answered request covered the row (and, with a channel,
    the agent spoke there after), or once the row is gone.
  - `WritePlacement` gains `messageId` and `presented?: false` (a row stored
    and not presented to its agent, whose turn was alive), which the
    framework sets with `FrameworkConfig.presentationIndex` on.

  **Migration:** compare marks through `covers` and `markAtOrAfter` instead
  of reading `.sequence`; rename `readsDeferredWrite` to `readsRow`, and
  give a queued write's wake its held handle.
