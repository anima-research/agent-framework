- **Hosts that call an Agent directly:** seven calls now throw
  `EmptyCompileError` when a compile under the passthrough strategy
  selects none of the conversation that the agent's window holds. They are
  `runInference`, `runInferenceWithInjections`, `startStream`,
  `startStreamWithInjections` and `compileContext`, and
  `buildActivationRequest` and `compileWithInjections` without `dryRun`.
  The first four sent such a request before, and the last three returned
  it or its compile. To look at such a compile without the error, call
  `compileWithInjections` with `dryRun`. Catch the error with
  `isEmptyCompileError` where the host handles a failed call. Its
  `budgetTokens` and `reserveTokens` give the budget that the compile had.
  A compile made while a tool-result batch holds back its reserve isn't
  refused. When the agent's window holds no conversation at all, its
  request is sent as before. Only the framework records a manager's view,
  so for a manager that the host opens itself, the check counts every row
  of the window as one the agent sees. After a host first calls
  `presentRows`, a row that it stores with `addMessage` and doesn't
  present stays out of the window, as before.
