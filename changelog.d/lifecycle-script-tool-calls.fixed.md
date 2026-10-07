- MCPL tool lifecycle (RFC-007) now reports the tool calls a `code_execution`
  script makes, not just the script's own `code_execution` call. Each is
  reported like a model call, under the inner tool's own name and class, so
  grants, narrowing, filters and the `comms`/unclassed input exclusions apply
  to it as they would to the model calling that tool directly. It carries the
  inference that issued the `code_execution` call and, in
  `_meta["agent-framework/parentToolCallId"]`, that call's `toolCallId`. A
  stream's end does not abort these calls: one still running when its script
  is killed is reported `completed` or `failed` when it finishes.
- Two `code_execution` calls in one model response no longer hang the turn.
  The runner now claims itself before it waits for the interpreter, so the
  second call is refused with "already running" and the first runs normally.
  Before, both got through: the second was refused by the interpreter, the
  first script's result was dropped, and its tool call never answered.
