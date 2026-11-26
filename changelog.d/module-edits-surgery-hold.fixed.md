- **Modules:** during a store surgery (`switchBranch`, `rollbackToMessage`,
  `suppressMessages`), a module's edits and removals now wait in memory with
  its writes, in the order they came, and the release applies them on the
  branch that the move lands on. Before, they changed the branch that the
  move was leaving. So a rollback lost them, and a removal of the
  rollback's target made the rollback fail. At the release, a change is
  skipped where the move cut its row away. A module's edits and removals
  also wait while the delivery agent's context manager refuses its work, as
  its writes already did. So they no longer throw at the module. The
  agent's recovery applies them. Until then, the module's `getMessage` and
  `queryMessages` show the changes that wait, and its
  `findMessageByExternalId` keeps a removed row's entry. A malformed edit
  still throws at once.
