- **`undoLastTurn()` and `redo()` reserve the store as a surgery does.** The
  branch moves under every agent sharing the store, so each is refused with
  `OperatorActionError` (`agent-busy`) while any of those agents is busy,
  not only the one named. Each still returns its result at once, with the
  store moved, and the store stays reserved after it returns until every
  agent's context manager is re-initialized for the new branch: no turn
  starts before then, and a `rollbackToMessage()`, `suppressMessages()` or
  `switchBranch()` made meanwhile is refused as busy. An undo or redo made
  meanwhile moves the store again under the same reservation, and the
  managers are re-initialized for the branch the last one leaves.
