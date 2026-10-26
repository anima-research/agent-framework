- A tool call whose arguments membrane marks as not the model's (`unparseableInput`) no longer runs (#363). The model gets an error result that says what came instead, and can call again:
  - text that isn't JSON, with the start of it;
  - arguments cut off before any arrived;
  - an array, a number, a string or a boolean, in the words a module tool's check uses (#372);
  - an object from a response whose parts arrived out of order, which may be another call's.

  A call marked as JSON `null` runs as a call with no arguments, as before. A refused `skip_reply` silences nothing after its round, as with one the agent's `allowedTools` refuses. `ToolCall` declares `unparseableInput`, the calls `Agent.runInference` returns keep it, and `executeToolCall` and a module's `callTool` answer a marked call with the same text, as a failure, without running it.
