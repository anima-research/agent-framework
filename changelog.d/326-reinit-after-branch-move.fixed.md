- **After the store's branch moves, every agent sharing it works again
  without a restart, unless its re-initialization fails.**
  `rollbackToMessage()`, `suppressMessages()`, `switchBranch()`,
  `undoLastTurn()` and `redo()` now re-initialize every agent's context
  manager for the branch the store is on, before the store is released. A
  rollback or suppression waits for them before it returns. Before,
  context-manager re-initialized only a manager that made the move itself:
  after a rollback or suppression, every agent but the one named kept a
  strategy loaded for the branch the store had left, and after a branch
  switch, undo or redo every agent did. An autobiographical strategy then
  refused that agent's compiles, its readiness and its maintenance until the
  host restarted. A manager whose re-initialization fails raises an ops
  alert, `context-reinit-failed`, naming its agent and the move; it is
  logged and traced each time, and the alert webhook posts it at most once
  per agent in 15 minutes, as it does every kind. That agent refuses its
  work, compiles and message writes included, until `switchBranch()` (to
  the branch the store is already on, too) or a restart re-initializes it.
  The move itself stands. A rollback or suppression whose switch back to the
  source branch fails as well raises the same alert for the agent it named.
