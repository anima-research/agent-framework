- **Hosts that call an Agent directly:** six calls now throw
  `EmptyCompileError` when the compile selects none of the conversation
  that the agent's window holds. They are `runInference`,
  `runInferenceWithInjections`, `startStreamWithInjections`, and
  `buildActivationRequest`, `compileContext` and `compileWithInjections`
  without `dryRun`. The first three sent such a request before, and the
  last three returned it or its compile. Catch the error with
  `isEmptyCompileError` where the host handles a failed call. Its
  `budgetTokens` and `reserveTokens` give the budget that the compile had.
  A compile made while a tool-result batch holds back its reserve isn't
  refused. A window that holds no conversation is sent as before. After a
  host first calls `presentRows`, a row that it stores with `addMessage`
  and doesn't present stays out of the window, as before.
