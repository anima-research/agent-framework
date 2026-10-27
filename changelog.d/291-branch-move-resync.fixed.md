- A move of the store's branch carries every live agent's window to the new branch (#291). The presentation index
  wrote each agent's window down once, at its registration, so a move to a branch made before that write-down (any
  branch an earlier release's store holds, or a rollback into rows the write-down presented, which `branchAt` cuts
  at their own sequence) left the agent in legacy mode for the rest of the process, where a write during its turn
  entered its window at once and `undoLastTurn` was refused, blaming a write-down that had worked. Now, beside the
  re-initialization of every agent's context manager after a move (the 326-reinit-after-branch-move entry), every
  agent is rebased under the move's store reservation: its window is written down where the new branch has none
  (traced as `presentation:presented` at `'rebase'`), and its own rows not in its window are presented. An agent
  whose manager's re-initialization fails, or whose window can't be written down, stays in legacy mode until the
  next move, traced as `presentation:failed` at `'rebase'`; the move itself stands. Every agent's redo entries are
  dropped at a move: each undid a window of the branch the store left.
