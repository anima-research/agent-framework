- **Hosts that read an agent's watermarks, or queue wakes with
  `readsDeferredWrite` or `readsStoredMessage`:** an agent's read marks move
  to its window (#291).
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
    is the stored row the wake is for, where it was the deferred queue
    entry's id (the queue is gone: a write is stored at once). The wake is
    dropped, as before, once an answered request covered the row (and, with
    a channel, the agent spoke there after), or once the row is gone.
  - `InferenceRequest.readsStoredMessage` (0.28.0, #814) is folded into
    `readsRow` as well: a wake for a message stored for its agent as it
    arrived carries `readsRow`, the row's stored id, as a wake for a row
    stored during the agent's turn does, and is judged as one (the
    291-reads-row changed entry).
  - `WritePlacement.messageId` names the stored row of every write stored at
    once, and `WritePlacement` gains `presented?: false` (a row stored and not
    presented to its agent, whose turn was alive).

  **Migration:** compare marks through `covers` and `markAtOrAfter` instead
  of reading `.sequence`; rename `readsDeferredWrite` and
  `readsStoredMessage` to `readsRow`, and give it the stored id the write was
  answered.
