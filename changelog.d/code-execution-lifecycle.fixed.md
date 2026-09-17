- Prevent concurrent interpreter startup from losing an execution; settle startup
  cancellation and reject stale tool/wake replies after interpreter replacement.
  Preserve sub-second Python tool timeouts.
- Serialize background wake delivery across rate limits and caps; report delivery
  failure to Python. Keep deferred end-turn effects scoped to their execution.
