- `EmptyCompileError` and `isEmptyCompileError` are exported. Agent throws
  `EmptyCompileError` before it sends a request whose compile, under the
  plain passthrough strategy, holds none of the conversation. The error is
  not retryable. Its `message` tells the caller that the request was not
  sent. Its `budgetTokens` and `reserveTokens` give the budget that the
  compile had, and its `operatorNote` gives the strategy, the budget's
  figures and what to change. On the framework's turns, the
  `inference:exhausted` trace carries the `empty_compile` error type and
  the `operatorNote`.
