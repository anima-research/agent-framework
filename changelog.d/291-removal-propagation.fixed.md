- A row removed from the record leaves every live agent's window that held it (#291), each at its own place, so no
  other row's place moves, traced as `presentation:retracted` with the removal's reason: after a `hide`, a
  suppression, a module's `removeMessage` and a process answer's `removeMessages`, the coalescer's removal of an
  unread row, a suppression a start finishes, and a refusal rewind's shed of a window that is still the record. A
  window on a branch whose record still holds the row (a fork, a derived agent's view made before the removal) keeps
  it, a window that is still the record is never written to, and a rollback needs none: it is a branch cut, made at
  the same place in every window.
- A suppression on a presented window takes its rows out of what every reader of them folded (#291): every other
  agent's strategy hears the rows leave its window, and an autobiographical strategy drops each summary that folded
  one of them, with every summary above it, and folds the rows it keeps again. Before, a suppression was not
  retroactive over derived state, and a summary that had folded a suppressed row went on showing it; on a window that
  is still the record it still isn't. The agent isn't told that its summaries were dropped and folded again, after a
  suppression, a hide or an undo alike: a current limit, which docs/dendrite.md names.
- At start, each window lets go of the rows its record no longer holds that no live context heard removed, such as an
  offline recovery's suppressions (`presentation:retracted`, reason `boot`).
- A rollback's accounting on a presented window is the cut's: `branchAt` cuts at the write that presented the target,
  so the rows stored between the target and that write stay on the new branch, and `messagesRemoved`, the removed refs
  and the Discord marks of `rollbackToMessage`, its preview, the host command's message-granular undo and offline
  recovery are exactly the rows stored after the cut (offline recovery checks those rows' tool pairs only). A rollback
  that would remove nothing and take nothing out of the window is refused as a no-op, saying why. When its target was
  presented in one write with rows after it, the refusal names the first of them and points to `suppressMessages` with
  every one of their row ids, grouped by the agent each goes through (for a row of a slot the agent observes, the
  agent whose own slot holds it, or, where that slot holds no other row, that the suppression there is refused), or to
  the host's `hide` with the Discord message ids of those that have one, each with the agent to run it on. A row
  holding a result of a call at or before the target isn't advised for suppression, which would leave the call without
  its result: the refusal says to roll back before the call, naming the message before it, and offers suppression for
  the rest.
- Offline recovery on a presented window:
  - refuses a cut that would change nothing, as the live rollback does, a dry run too, and an anchor already at the
    window's tail. Its refusal names the rows with a Discord id for `--suppress` (`suppressMessageIds`) in the same
    recovery, and a row without one (an agent's round, a tool row), which that suppression can't name, by its row id
    for the live `suppressMessages` once the host runs; it says to anchor before the call for a row holding a call's
    result at or before the anchor, and offers no `--suppress-range`, which would take every row between its ends, any
    agent's. Its suppression may name a row the cut keeps after the anchor.
  - reports the rows its cut returns to the arrivals as `returnedToArrivals`, a dry run too (a row the same recovery
    suppresses is counted as suppressed instead), so a cut that only returns rows doesn't read as changing nothing
    (`messagesRemoved: 0`, `messagesSuppressed: 0`); `0` for a run with no anchor, absent on a window that is still
    the record. It reads the agent's own slot alone, so a row of a slot the agent observes isn't counted there or
    weighed by the no-op check, which the refusal says.
  - with `removeSuppressed` alone (`--remove-suppressed`, no anchor) takes the newest row as on a legacy window,
    branching at the head with the suppressed rows removed, and a run with nothing left to suppress makes its branch,
    removing 0.
