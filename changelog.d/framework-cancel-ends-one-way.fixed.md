- A stream that reports the framework's own cancel as an `error`, by just closing, or by
  throwing, now ends an endTurn or a budget restart the way an `aborted` one does. After
  an `error`, neither is traced as `inference:failed`, logged as a failed inference, or
  handed to the error policy. After a throw, neither is traced as `inference:failed` or
  `inference:exhausted`, or leaves an "[inference-failed]" note in the agent's context.
  In every shape, the stream's §10.5 lifecycle terminal reads `aborted`, an endTurn writes
  its delivery receipt and starts the continuation it was asked for, and a budget restart
  keeps the event gate's window open for its new stream, which takes over the turn's
  typing and streamed message. A stop, a quiesce abandon or a caller's stop over a stream
  that throws ends as one, as it already did over the other shapes, and the throw is said
  on the console. A stream that reports its cancel as an `error` and then throws ends
  once. membrane's yielding stream reports a cancel as `aborted`, so this reaches other
  stream implementations.
- A budget restart whose new start fails before its stream exists, such as on a store
  write, no longer leaves the agent's window open at the event gate, which kept every
  gate event buffered, for every agent. This happened with membrane's `aborted` restarts.
