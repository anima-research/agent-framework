- A rollback or suppression whose switch failed, and whose restore selected
  the source branch but couldn't initialize the agent's context manager,
  leaves that agent's window in legacy mode, traced as
  `presentation:failed` at `'rebase'` with the cause, until a branch move
  re-initializes the manager, and writes kept in memory for it stay kept:
  what follows the move doesn't count that manager as re-initialized, so
  its window isn't rebased and read as presented while its strategy refuses
  its work, and its kept writes aren't logged as recovered. A manager that
  refused its work and whose own rollback or suppression switch then
  succeeds counts as working again.
