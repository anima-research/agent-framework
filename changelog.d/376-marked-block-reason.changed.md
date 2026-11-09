- A tool call membrane marks with `unparseableInput` is now refused for its
  marker before the agent's tool permissions are checked, on the dispatcher
  and through `executeToolCall`. A marked call to a tool the agent may not
  call used to get the allowedTools refusal, and now gets the refusal that
  says its arguments weren't the model's.
- Prose segments no longer break at `tool_attempt` or `tool_notice` blocks.
  No released membrane produces them. A refused XML block now reaches the
  framework as a round of marked calls, which segments its prose as any
  tool round does.
