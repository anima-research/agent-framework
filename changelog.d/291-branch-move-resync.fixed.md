- A move of the store's branch re-synchronizes every live agent (#291). `switchBranch`, `rollbackToMessage`,
  `suppressMessages` and a failed surgery's restore of its source branch moved the store under every agent sharing
  it, but only the acting agent's context, or none for `switchBranch`, initialized its strategy again: every other
  agent with `AutobiographicalStrategy` failed each turn ("requires reinitialization for the current branch
  generation") until the process restarted, so a host's `/checkout`, or a co-resident's rollback, left agents
  unusable. Now, under the move's store reservation, every other live context is initialized again on the store's
  branch (`ContextManager.reinitializeOnStoreBranch`). And the presentation index wrote each agent's window down
  once, at its registration: a move to a branch made before that write-down (any branch an earlier release's store
  holds, or a rollback into rows the write-down presented, which `branchAt` cuts at their own sequence) left the
  agent in legacy mode for the rest of the process, where a write during its turn entered its window at once and
  `undoLastTurn` was refused, blaming a write-down that had worked. Now every agent is rebased after the move: its
  window is written down where the new branch has none (traced as `presentation:presented` at `'rebase'`), and its
  own rows not in its window are presented. A context whose strategy can't follow, or whose window can't be written
  down, leaves its agent in legacy mode until the next move, logged and traced as `presentation:failed` at
  `'rebase'`; the move itself stands. Every agent's redo entries are dropped at a move: each undid a window of the
  branch the store left.
