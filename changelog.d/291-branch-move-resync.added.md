- `switchBranch(name, { requester?, note? })` writes the switch to the operator log as a `checkout`, with its source
  and target branches, or with its error when it is refused or fails (a call after `stop()` has begun is refused
  before anything is logged) (#291); the API server's `branch.switch` logs
  one with requester `{ via: 'api' }`. Before, a branch switch was the one branch move the operator log didn't
  record.
- `PresentationOccasion` gains `'rebase'`: the store's branch moved under a live agent, and its window was written
  down on the new branch, or couldn't be (`presentation:presented` and `presentation:failed`). A move of the store's
  branch carries every live agent's window to the new branch: it is written down where that branch has none, and the
  agent's own rows not in its window are presented. An agent whose window can't be written down there stays in legacy mode until the next move, and the move itself stands. So does an agent whose context manager a failed rollback's or suppression's restore couldn't re-initialize, its kept writes waiting for a move that does; a refusing manager whose own rollback or suppression succeeds works again. Every agent's redo entries are dropped at a move.
