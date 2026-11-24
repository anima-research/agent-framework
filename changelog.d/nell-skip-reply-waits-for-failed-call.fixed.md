- A failed send beside `skip_reply` now reaches the model before the turn
  ends. A send is a call of a tool in the framework's speech list, such as
  `send_message`, `send_dm` or `send_file`, or a `drafts` call that resends.
  Only the step's own calls count, so a send made inside a script or through
  `toolsets--act` isn't one. With sends in the same step, a `skip_reply` now
  waits for their answers. Only then does it arm its wake and send its
  tool-lifecycle `started` event. Only an answer marked `isError` counts as
  a failure. If a send failed, the step's `skip_reply` calls don't run. Each
  gets an error that names the failed tools and asks for `skip_reply` again.
  The model is then called again with every answer of the step, unless a
  call such as `sleep` ends the turn. That costs one more model call. A
  refused `skip_reply` reports no tool-lifecycle events, and the refusal
  happens once per turn. Later in the turn, `skip_reply` runs as before,
  even beside a failed send. Beside a failed call that isn't a send,
  `skip_reply` runs as before. A `skip_reply` with bad arguments is still
  answered at once. A script's own `skip_reply` also runs at once. With
  `sameRoundSkipReplyTextPolicy: 'ask'`, a step can meet both rules. It then
  gets one refusal: the policy's words and one added sentence.
