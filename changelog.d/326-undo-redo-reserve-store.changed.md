- **`undoLastTurn()` and `redo()` reserve the store as a surgery does.** The
  branch moves under every agent sharing the store, so each is refused with
  `OperatorActionError` (`agent-busy`) while any of those agents is busy,
  the one named included (that one used to throw a plain `Error`). Each
  still returns its result at once, with the store moved. The
  re-initialization of every agent's context manager finishes after the
  call returns, and the store stays reserved until it's done: a turn asked for meanwhile starts after, and a
  `rollbackToMessage()`, `suppressMessages()` or `switchBranch()` made
  meanwhile is refused as busy. A runtime-settings change, reset or
  cancelled transition made meanwhile, or during a surgery, is refused with
  `OperatorActionError` (`agent-busy`) before any of it is applied. A context-settings preview made meanwhile is
  refused by context-manager until that agent's manager is current, as
  during a surgery's switch. An undo or redo made meanwhile moves the
  store again under the same reservation, and the managers are
  re-initialized for the branch the last one leaves. The re-initialization
  waits first for maintenance already running, a pass or an over-budget
  drain kick; the move itself is synchronous, so a maintenance tick running
  at that moment still runs across it, as before. That tick's work was for
  the branch the store left, so what it meets then isn't reported as a
  maintenance failure; a lasting failure, such as the provider's, meets the
  next tick too.
  Creating a conversation agent waits while a move or a surgery holds the
  store, since its context is seeded from the template's, and a move made
  while one is being created is refused as busy. An undo or redo that fails leaves the store where it was, with
  the turn still there to undo or redo, unless its branch has been deleted:
  a redo whose branch is gone drops that step, and any beneath it whose
  branches are gone too, and says so.
- **A second `switchBranch()` made while one holds the store is refused**
  with `OperatorActionError` (`agent-busy`), as the other operator calls
  are.
