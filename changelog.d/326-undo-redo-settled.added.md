- **`undoLastTurn()`'s and `redo()`'s results carry `settled` when the store
  moved:** a promise that settles once the store's reservation is released,
  each agent's context manager re-initialized for the branch the store moved
  to or its failure alerted. It never rejects. Await it before work that
  needs the store free: a compile on an agent's own context manager, which
  refuses until that manager is re-initialized, or a write meant to land at
  once, which the reservation defers. An undo or redo made while an earlier
  one's managers re-initialize settles with it. The API server's `undo` and
  `redo` now wait for it before they broadcast `branch:switched` and answer,
  so a client that reads an agent's context when it hears the event gets it.
  Their answers are as before, without the promise.
