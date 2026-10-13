- A `code_execution` script no longer receives another script's tool result.
  Inner-call ids restart in every interpreter, and a result was delivered to
  whichever interpreter was current when it arrived: after a script was
  aborted, killed at its time limit, or crashed mid-call, the late result of
  its call could resolve the first call of the next script, which then went
  on with the wrong data. Results and wake acknowledgements now go only to
  the interpreter that asked; one whose interpreter is gone is dropped and
  logged.

- A tool call that ends the turn, made by a `code_execution` script that was
  stopped before the call finished, no longer ends the turn of the agent's
  next script. The deferred end-turn request was kept per agent; it now marks
  only the foreground script that made the call. Background scripts' requests
  no longer reach a foreground script running alongside them.
