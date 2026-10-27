- `nudgeAgent()` reports an agent whose turn waits for its continuation (a
  context-budget restart's, or the tool-result guard's retry) as
  `idle+turn-alive`, in its result, its log line and the operator-action
  record, as it does an agent holding a turn token. It used to report
  `idle`, which its doc says means the turn starts on the next scheduler
  pass, though that pass started none (#754).
