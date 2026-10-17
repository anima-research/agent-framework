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
  per agent and kind in 15 minutes, as it does every kind. That agent refuses its
  work, compiles and message writes included, until `switchBranch()` (to
  the branch the store is already on, too) or a restart re-initializes it.
  The move itself stands. A rollback or suppression whose switch back to the
  source branch fails as well raises the same alert for the agent it named,
  and says which branch the store is on. A rollback or suppression refused
  before the store moved, such as one whose branch name is already taken,
  re-initializes nothing. Each move re-initializes every agent on the store,
  one at a time with the event loop running between them, so the store stays
  reserved for longer as agents and their stored history grow, while the
  host goes on handling events; most of each agent's own re-initialization
  still runs without a break.
- **A conversation agent with no stored message of its own on the branch
  the store moves to is seeded again from the template,** as one spawned
  after the point a move returns to has none there. A conversation agent
  was seeded only when it was created, so re-initialized it would have
  answered with no history. It's now seeded as at its creation, from the template's
  context as it stands on that branch, and keeps its name and its channel.
  What reaches it while the move holds the store, from its channel, a
  correction for it or its idle closure, is written after that, as every
  agent's writes are; before, it was written at once, where the re-seed found
  it and seeded nothing, or on the branch a rollback was about to leave.
  A move back to a branch that holds its own history, such as a redo after
  an undo, finds that history and seeds nothing. One spawned before that
  point keeps its history, even where that history compiles to nothing.
  One that can't be seeded, because its seeding fails, the store moves to
  another branch while it's seeded by a switch the framework didn't make, or
  the template is missing or failed to re-initialize, is disposed rather than left to
  answer with no history: `context-reinit-failed` says so and why. Its
  channel's next qualifying message spawns a fresh one, unless its seeding
  fails again, and while the template is missing or refuses its work a
  spawn fails too, so the alert says what puts the template right first.
  Its messages stay in the store, but a redo doesn't bring the disposed one
  back.
