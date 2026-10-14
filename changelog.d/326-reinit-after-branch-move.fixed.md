- **After the store's branch moves, every agent sharing it works again
  without a restart.** `rollbackToMessage()`, `suppressMessages()`,
  `switchBranch()`, `undoLastTurn()` and `redo()` now re-initialize every
  agent's context manager for the branch the store is on, before the store
  is released. Before, context-manager re-initialized only a manager that
  made the move itself: after a rollback or suppression, every agent but the
  one named kept a strategy loaded for the branch the store had left, and
  after a branch switch, undo or redo every agent did. An autobiographical
  strategy then refused that agent's compiles, its readiness and its
  maintenance until the host restarted. A manager whose re-initialization
  fails raises an ops alert, `context-reinit-failed`, naming its agent. That
  agent refuses its work, compiles and message writes included, until
  `switchBranch()` (to the branch the store is already on, too) or a restart
  re-initializes it. The move itself stands.
