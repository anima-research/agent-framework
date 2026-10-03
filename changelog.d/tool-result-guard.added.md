- Add the opt-in, durable `agent_settings.tool_result_guard` setting
  (programmatic `AgentConfig.toolResultGuard`; hosts must forward it from
  recipes). On a provider refusal after tool output, withhold the
  latest result batch and retry inference once without rerunning tools or
  automatically rewinding older messages. Full originals remain in an
  append-only Chronicle audit log (synced before submission); pending output
  stays out of speculative compression and the placeholder is held from
  compression until settled (requires context-manager ^0.12.0), guard effects apply only to a batch
  actually submitted in the current turn, and disabling the guard does not restore withheld results.
- Recover from failed staging/link audit appends and accepted-result history
  edits without stranding streams or compression holds. Retry storage work
  before activation, during maintenance, and at shutdown; preserve later
  operator edits and branch changes. End-turn output remains withheld when
  its audit was not made durable.
