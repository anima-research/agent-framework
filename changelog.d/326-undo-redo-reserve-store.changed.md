- **`undoLastTurn()` and `redo()` reserve the store as a surgery does**
  (their new refusals are under Breaking). An undo or redo of an agent that
  is itself busy is refused with `OperatorActionError` (`agent-busy`), where
  it threw a plain `Error`. Each still returns its result at once, with the
  store moved, and its `settled` says when the store is let go. The
  re-initialization of every agent's context manager finishes after the
  call returns, and the store stays reserved until it's done: a turn asked for meanwhile starts after, and a
  `rollbackToMessage()`, `suppressMessages()` or `switchBranch()` made
  meanwhile is refused as busy. A context-settings preview made meanwhile is
  refused by context-manager until that agent's manager is current, as
  during a surgery's switch. An undo or redo made meanwhile moves the
  store again under the same reservation, and the managers are
  re-initialized for the branch the last one leaves. The re-initialization
  waits first for maintenance already running, a pass or an over-budget
  drain kick; the move itself is synchronous, so a maintenance tick running
  at that moment still runs across it, as before. Its work was for the
  branch the store left, so context-manager's refusal of that work isn't
  reported as a maintenance failure; any other failure it meets is.
  Creating a conversation agent waits while a move or a surgery holds the
  store, since its context is seeded from the template's, and a move made
  while one is being created is refused as busy. An undo or redo that fails
  leaves the store where it was, with the turn still there to undo or redo
  (before, a failed undo lost its turn, and a failed redo its step), unless
  it's a redo whose branch has been deleted, which drops that step and says
  so, naming the branch and how many redo steps remain.
- **While the store is held, by a surgery, a branch switch, an undo or a
  redo, a coalesced update or retraction no longer removes the stored,
  unread message it updates or withdraws.** The update, or the retraction's
  notice, is added once the store is released, and a retraction with no
  notice leaves the message in place, so an agent can read a message
  withdrawn while the store was held.
