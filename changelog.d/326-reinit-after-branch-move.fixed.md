- **After the store's branch moves, every registered agent sharing it works
  again without a restart, unless its re-initialization fails.**
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
  source branch fails as well raises the same alert for the agent it named,
  and says which branch the store is on. A rollback or suppression refused
  before the store moved, such as one whose branch name is already taken,
  re-initializes nothing. Each move re-initializes every agent on the store,
  so its cost grows with the number of agents and with each one's stored
  history; it hasn't been measured on a large store.
- **A conversation agent spawned after the point a move returns to is
  seeded again from the template.** On the branch the store moved to its
  context is empty, and a conversation agent was seeded only when it was
  created, so re-initialized it would have answered with no history. It's
  now seeded as at its creation, from the template's context as it stands
  on that branch, and keeps its name and its channel. A move back to a
  branch that holds its own history, such as a redo after an undo, finds
  that history and seeds nothing. One spawned before that point keeps its
  history. If seeding it fails, it's disposed rather than left to answer
  with no history, the failure raises `context-reinit-failed` saying so,
  and its channel's next qualifying message spawns a fresh one.
