- The `context-reinit-failed` alerts, a failed surgery's restore message,
  the `store-held-lost` alert at stop, and the log line for writes kept in
  memory for a manager that refuses its work now say that any branch move
  re-initializes the manager and stores those writes: `switchBranch()` to
  the current branch, as they suggest, or a rollback or suppression made
  through another agent. In 0.32.0 the `context-reinit-failed` alerts and
  the restore message, the two of these it had, named `switchBranch()`
  alone.
