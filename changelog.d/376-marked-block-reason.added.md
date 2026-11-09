- A tool call marked with `unparseableReason` beside `unparseableInput`,
  such as each call of a malformed XML `function_calls` block a membrane
  refuses, is refused with that reason: "Nothing was done: `<tool>` didn't
  run, because the function_calls block it was in isn't well-formed:
  `<reason>`.", then how to send the block's calls again. A call the block
  gave no name to gets the same sentence without one. Such a call is refused
  whatever its marked text is, JSON `null` included. In XML tool mode the
  stored round keeps both fields on each refused call, so the history tells
  it from a call made with no arguments. `ToolCall` gains
  `unparseableReason`. A marked call with no reason is refused as before.
