- A rollback or suppression whose switch failed, and whose restore selected
  the source branch but couldn't initialize the agent's context manager,
  now leaves that agent's window in legacy mode, traced as
  `presentation:failed` at `'rebase'` with the cause, until a branch move
  re-initializes the manager. Writes kept in memory for it stay kept. Before,
  following the move counted that manager as re-initialized: it rebased the
  agent's window and read it as presented though its strategy refused its
  work, and it logged the agent's kept writes as recovered. A manager that
  refused its work and whose own rollback or suppression switch then
  succeeds no longer counts as refusing.
