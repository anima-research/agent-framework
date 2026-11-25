- **Hosts that call an Agent directly:** four calls now throw
  `EmptyCompileError` when the compile selects none of the conversation in
  the agent's window. They are `runInference`, `runInferenceWithInjections`,
  and `compileContext` and `compileWithInjections` without `dryRun`. The
  first two sent such a request before, and the last two returned the
  empty compile. Catch the error with `isEmptyCompileError` where the host
  handles a failed call, and read its `operatorNote` for what to change.
  After a host first calls `presentRows`, a row that it stores with
  `addMessage` and doesn't present stays out of every request, as before.
  Where the window holds other conversation and the compile selects none
  of it, the call now throws.
