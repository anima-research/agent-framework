- `EmptyCompileError` and `isEmptyCompileError` are exported. Agent throws
  `EmptyCompileError` before it sends a request whose compile holds none
  of the conversation. The error is not retryable. Its `residentNote` is
  the agent's reason, with the newest message's sender and channel. Its
  `message` tells the caller that the request was not sent, without those
  names. Its `operatorNote` gives the strategy, the budget's figures and
  what to change. On the framework's turns, the `inference:exhausted`
  trace carries the `empty_compile` error type, the `operatorNote` and
  `emptyCompileUsable`. The direct API (`runInference`,
  `runInferenceWithInjections`) now throws the error in place of sending
  such a request, and so does `compileWithInjections` without `dryRun`. A
  host that stores rows with `addMessage` and doesn't present them
  (`presentRows`) sends none of those rows, as before. The call now throws
  when the window holds other conversation and the compile selects none of
  it.
