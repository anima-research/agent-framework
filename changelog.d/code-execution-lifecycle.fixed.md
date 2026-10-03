- Prevent concurrent interpreter startup from losing an execution; settle startup
  cancellation and reject stale tool/wake replies after interpreter replacement.
  Preserve sub-second Python tool timeouts.
- Serialize background wake delivery across rate limits and caps; report delivery
  failure to Python. Keep deferred end-turn effects scoped to their execution: an
  inner end-turn ends only a turn still waiting on its script, never a later one.
- Ephemeral agents wait for their foreground scripts to finish, since they cannot
  receive a completion notice. Results a completion notice announced are kept until
  retrieved (at most 20 per agent). An invalid `codeExecution.foregroundWaitMs` is
  refused when the framework is created instead of failing every call.
- Quiesce keeps its guarantee for foreground scripts that outlived their turn:
  `drained` waits for them and `abandon` stops them; host status adds
  `foregroundScripts`. Background watchers stay exempt.
- `wake_agent` messages count as conversation again; completion notices are system
  messages. The `code_execution` description keeps its original guidance and adds
  the waiting behaviour.
