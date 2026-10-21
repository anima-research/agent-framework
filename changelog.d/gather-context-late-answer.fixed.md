- **A module's `gatherContext()` that answers after its timeout is dropped
  whole.** Its injections were still added to the list `gatherContext()` had
  already returned for the turn, and its `[deprecated]` line was logged. Now
  an answer after the timeout is neither added nor logged.
- **A module whose `gatherContext()` throws before returning a promise fails
  alone,** logged and skipped as a module that rejects is. It made the
  registry's `gatherContext()` throw, so no module's injections were
  returned.
