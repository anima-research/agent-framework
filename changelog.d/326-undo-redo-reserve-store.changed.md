- **A move of the store's branch holds the store until every agent's context
  manager is re-initialized** (its new refusals are under Breaking): a turn
  asked for meanwhile starts after, and a `rollbackToMessage()`,
  `suppressMessages()` or `switchBranch()` made meanwhile is refused as busy.
  A context-settings preview made meanwhile is refused by context-manager
  until that agent's manager is current, as during a surgery's switch. The
  re-initialization waits first for maintenance already running, a pass or
  an over-budget drain kick. Creating a conversation agent waits while a move
  or a surgery holds the store, since its context is seeded from the
  template's, and a move made while one is being created is refused as busy.
  `undoLastTurn()` and `redo()` are on the agent's window (#291): they move no
  branch, so they hold nothing and re-initialize nothing, and a conversation
  agent being created doesn't refuse them.
- **While the store is held, by a surgery or a branch switch, a coalesced
  update or retraction no longer removes the stored, unread message it
  updates or withdraws.** The update, or the retraction's notice, is added
  once the store is released, and a retraction with no notice leaves the
  message in place, so an agent can read a message withdrawn while the store
  was held.
