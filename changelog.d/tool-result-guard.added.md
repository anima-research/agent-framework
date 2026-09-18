- Add the opt-in, durable `agent_settings.tool_result_guard` setting (recipe:
  `toolResultGuard`). On a provider refusal after tool output, withhold the
  latest result batch and retry inference once without rerunning tools or
  automatically rewinding older messages. Full originals remain in an
  append-only Chronicle audit log; pending output stays out of speculative
  compression, and disabling the guard does not restore withheld results.
