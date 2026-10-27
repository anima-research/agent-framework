- A tool call whose arguments membrane marks as not the model's (`unparseableInput`) no longer runs (#363). The model gets an error result that says what came instead, and can call again:
  - none of its arguments, when they never arrived;
  - text that isn't JSON, which may have been cut off, with the start of it;
  - an array, a number, a string or a boolean, in the words a module tool's check uses (#372);
  - an object from a response that didn't arrive whole and in order, which can't be taken as the call's own.

  A call marked as JSON `null` still runs, as a call with no arguments: its input is `{}`, whatever its block carried. A refused `skip_reply` silences nothing after its round, and a refused send counts for nothing, as with calls the agent's `allowedTools` refuses. `ToolCall` declares `unparseableInput`, and the calls `Agent.runInference` returns keep it. `executeToolCall`, a module's `callTool`, a queued `tool-call` event and `ModuleRegistry.handleToolCall` answer a marked call with the same text, as a failure, without running it, except one marked as JSON `null`, which runs with no arguments.
