- `code_execution` takes an optional per-call `time_limit_ms`: the time limit for
  that script, the way Claude Code's Bash tool takes a per-call timeout. It
  defaults to `codeExecution.scriptTimeoutMs` (10 min) and may go up to the new
  `codeExecution.maxScriptTimeoutMs`, which defaults to the same value, so
  agents can only shorten the limit until a deployment raises the ceiling.
  Longer requests are capped and the result says so (`time_limit_note`). For a
  background script it shortens the lifetime, capped at
  `backgroundMaxLifetimeMs`. The tool description now states the limit, and a
  script stopped at its limit says so instead of only "cancelled by host".
