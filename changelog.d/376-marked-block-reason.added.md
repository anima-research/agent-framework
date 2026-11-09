- A tool call marked with `unparseableReason` beside `unparseableInput`,
  such as each call of a malformed XML `function_calls` block a membrane
  refuses, is refused with that reason: "Nothing was done: `<tool>` didn't
  run, because the function_calls block it was in isn't well-formed:
  `<reason>`.", then how to send the block's calls again. A call the block
  gave no name to gets the same sentence without one. Such a call is refused
  whatever its marked text is, JSON `null` included, and before the agent's
  tool permissions are checked, since a malformed block's calls can name a
  tool the model never meant. In XML tool mode the stored round keeps both
  fields on each refused call, so the history tells it from a call made with
  no arguments, and a watching agent's transcript shows each such call as
  not run, with the reason. `ToolCall` gains `unparseableReason`. A marked
  call with no reason, or an empty one, is answered as before: refused if
  the agent may not call its tool, and otherwise by its marked text, so one
  whose text is JSON `null` runs with no arguments and any other is refused.
