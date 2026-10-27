- **`undoLastTurn()`'s and `redo()`'s result types carry an optional
  `settled`,** a promise that settles once the store's reservation is
  released, for an undo or redo that moved the store. An undo or redo is on
  the agent's window (#291) and moves none, so it is never present: nothing
  waits to settle, and an agent's context can be read as soon as the call
  returns. The API server's `undo` and `redo` await it when it is there, and
  answer without it.
