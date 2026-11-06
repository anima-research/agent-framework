- A row removed from the record now leaves every agent's window that held it (#291). context-manager takes a
  removal out of the window of the context it was made through only, and every other window on the slot, or
  merging it, kept the row's place: its compile left the row out, but its index length, and the places read marks
  and cursors are kept by, still counted it. After a `hide`, a suppression (on its fork), a module's
  `removeMessage` and a process answer's `removeMessages`, the coalescer's removal of an unread row, a suppression
  a start finishes, and a refusal rewind's shed of a window that is still the record, each other live window takes
  the rows out, each at its own place, so no other row's place moves, traced as `presentation:retracted` with the
  removal's reason. A window on a branch whose record still holds the row (a fork, a derived agent's view made
  before the removal) keeps it, and a window that is still the record is never written to. A window that can't be
  repaired is logged, and the removal stands. A rollback needs none: it is a branch cut, made at the same place in
  every window.
- A suppression on a presented window takes its rows out of what every reader of them folded (#291). Every other
  agent's context follows the suppression's fork before the removals, so its strategy hears the rows leave its window:
  an autobiographical strategy drops each summary that folded one of them, with every summary above it, and folds the
  rows it keeps again, as the strategy of the context the suppression was made through does. Before, a suppression
  was not retroactive over derived state, and a summary that had folded a suppressed row went on showing it; on a
  window that is still the record it still isn't. The agent isn't told that its summaries were dropped and folded
  again, after a suppression, a hide or an undo alike: a current limit, which docs/dendrite.md names.
- At start, each window lets go of the rows its record no longer holds that no live context heard removed, such as
  an offline recovery's suppressions, made through the one agent's context it opens with the host stopped
  (`presentation:retracted`, reason `boot`).
- A rollback's accounting on a presented window is the cut's. `branchAt` cuts at the write that presented the
  target, so the rows stored after the target and before that write stay on the new branch, but
  `rollbackToMessage`, its preview, the host command's message-granular undo and offline recovery counted every row
  after the target as removed, and marked their Discord messages. `messagesRemoved`, the removed refs and the marks
  are now exactly the rows stored after the cut, and offline recovery checks the tool pairs of those rows only. A
  rollback that would remove nothing and take nothing out of the window is refused as a no-op, saying why: when its
  target was presented in one write with rows after it, the refusal says so, names the first of them, and points to
  `suppressMessages` with every one of their row ids, grouped by the agent the suppression goes through (for a row of
  a slot the agent observes, the agent whose own slot holds it, and where that slot holds no other row, that the
  suppression there is refused), or the host's `hide` with their Discord message ids, to take them out; it names
  `hide` only where one of them has a Discord message id, and, where only some have one, for those alone.
- Offline recovery with `removeSuppressed` alone (`--remove-suppressed`, no anchor) on a presented window threw a TypeError before it made anything. It now takes the newest row as on a legacy window, branching at the head with the suppressed rows removed, and a run with nothing left to suppress makes its branch, removing 0, instead of being refused as an anchor "already the tail" of the window.
- Offline recovery's refusal of a no-op cut on a presented window told the operator to suppress the rows presented with the anchor in the same recovery, which names a row only by its Discord message id, so an agent's round or a tool row could not be taken out that way. A row with no Discord id is now named by its row id for the live `suppressMessages` once the host runs, the offline suppression advised for the rest.
- Offline recovery on a presented window reports the rows its cut returns to the arrivals as `returnedToArrivals`, a dry run too, as the live rollback does (a row the same recovery suppresses is counted as suppressed instead): a cut that only returned rows answered `messagesRemoved: 0` and `messagesSuppressed: 0`, as if it changed nothing. `0` for a run with no anchor; absent on a window that is still the record.
