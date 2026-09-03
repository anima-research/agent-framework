- `InferenceRequest.counterparty` carries the adapter-namespaced author id of
  the channel message that triggered the turn, and
  `getActiveTurnTrigger(agentName)` exposes the trigger of the turn in
  progress (kept beside the turn token, cleared wherever it is) so a host can
  stamp gateway telemetry with why the call exists and who woke the agent
  (#141).
