- A failed call beside `skip_reply` now reaches the model before the turn
  ends. When the model calls `skip_reply` beside other calls, the
  `skip_reply` now waits for their answers. Only then does it arm its wake
  and send its tool-lifecycle `started` event. If one of those calls failed,
  the step's `skip_reply` calls don't run. Each gets an error that names the
  failed tools and asks for `skip_reply` again. The model is then called
  again with every answer of the step, unless a call such as `sleep` ends the
  turn. A refused `skip_reply` reports no tool-lifecycle events, and the
  refusal happens once per turn. Later in the turn, `skip_reply` runs as
  before, even beside a failed call. A `skip_reply` with bad arguments is
  still answered at once. A script's own `skip_reply` also runs at once. With
  `sameRoundSkipReplyTextPolicy: 'ask'`, a step can meet both rules. It then
  gets one refusal: the policy's words and one added sentence.
