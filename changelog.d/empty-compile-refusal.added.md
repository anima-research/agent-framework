- `EmptyCompileError` and `isEmptyCompileError` are exported. Agent throws
  `EmptyCompileError` before it sends a request whose compile holds none
  of the conversation. The error is not retryable. Its `residentNote` is
  the agent's reason. Where the budget leaves room for conversation, the
  `residentNote` names the newest row that the compile left out. It names
  a message's sender and channel when the metadata gives them, and a
  context injection or a framework notice as such. Its `message` tells the
  caller that the request was not sent, without those names. Its
  `operatorNote` gives the strategy, the budget's figures, the id and kind
  of the row left out, and what to change. On the framework's turns, the
  `inference:exhausted` trace carries the `empty_compile` error type, the
  `operatorNote` and `emptyCompileUsable`.
