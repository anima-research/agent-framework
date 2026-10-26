- **After the store's branch moves, the context manager of every registered
  agent sharing it works again without a restart, unless its
  re-initialization fails.**
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
  alert, `context-reinit-failed`, naming its agent and the move, unless the
  agent has left by then, as a run its watchdog ended; it is
  logged and traced each time, and the alert webhook posts it at most once
  per agent and kind in 15 minutes, as it does any alert without a key of
  its own. Each alert says
  what happened and what to do or what happens next first, within the start
  the webhook keeps of a long message, whatever the branches it names, and
  its cause last.
  That agent refuses its
  work, compiles and message writes included, until `switchBranch()` (to
  the branch the store is already on, too) re-initializes it and stores the
  writes kept queued for it meanwhile, at resume on a quiesced host; a
  restart can lose those writes. `stop()` says how many writes it leaves queued for
  an agent whose store didn't take them, and whether they're kept for boot.
  That line, and its line for writes left queued behind a stream still
  running, now say the persisted queue's record is behind, rather than that
  boot keeps them, when the record's last write failed or met the cap.
  The move itself stands. A rollback or suppression whose switch back to the
  source branch fails as well raises the same alert for the agent it named,
  and says which branch the store is on, and whether the agent's manager
  refuses its work there, or, after a suppression whose removals failed and
  whose switch back couldn't select the source, is current on the
  suppression's branch, which its fork initialized it for, and serves from
  there until a `switchBranch()` moves it. A rollback or suppression refused
  before the store moved, such as one whose branch name is already taken,
  re-initializes nothing. Each move re-initializes every agent on the store,
  one at a time with the event loop running between them, so the store stays
  reserved for longer as agents and their stored history grow, while the
  host goes on handling events between agents. Each agent's own
  re-initialization can still hold the host for its whole length, which
  grows with that agent's stored history. Nothing bounds it, or the wait for
  maintenance already running that comes before it, so a move whose hold on
  the store is still up after 60 s raises one `store-held-long` ops alert.
  It says what a restart does: it ends the move, the conversation agents
  and the runs, and re-initializes the configured agents, and writes still
  queued at exit survive only in a persisted deferral queue. Then it names
  the agent the move was for, and the manager its pass is re-initializing
  or the maintenance it's waiting for. It's raised for every move that holds the store: a
  rollback, a suppression and a branch switch, as well as an undo or redo.
- **A conversation agent with no stored message of its own on the branch
  the store moves to is disposed,** as one spawned after the point a move
  returns to has none there. Re-initialized, it would answer with no
  history. Its channel is unbound, and `context-reinit-failed` says so, and
  how many writes were held for it while the store was held. Its channel's
  next qualifying message spawns a new fork from the template, under a new
  name, which needs the template's own context manager to be working. Its
  messages stay in the store, but no agent reads them again, so an undo and
  then a redo don't bring it back. It's disposed whether or not its own
  re-initialization succeeded, with the disposal's alert alone, which gives
  that failure's cause when there was one. After a rollback, a branch
  switch, an undo or a redo, every conversation agent is judged once, on
  the branch the store lands on, after every manager is re-initialized, so
  a fork an undo empties and a redo made before then restores is kept; a
  suppression can't empty one. One with stored history there
  stays, even where that history compiles to nothing. If disposing it fails
  partway, the alert says that too, and the others are still judged. What
  reaches a conversation agent while a move holds the store, from its
  channel, a correction for it or its idle closure, is written after the
  release, as every agent's writes are; before, it was written at once, on
  the branch a rollback was about to leave. A spawn that comes to create a
  conversation agent once a `stop()` of its lifecycle has begun, under way,
  done, or failed with no `start()` since, as one waiting out a move's hold
  can, fails as a failed spawn does, rather than open its context manager
  on a store `stop()` is tearing down or has torn down. A spawn waits out a
  move's hold before it stores its channel's name counter, so the counter
  is on the branch the store lands on, and a restart doesn't give a later
  fork that fork's name.
