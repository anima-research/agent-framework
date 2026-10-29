- **A host's `executeToolCall` reaches the framework's own tools.**
  `agent_settings`, `save_recent_image`, `read_image`, `fetch_reference`,
  `gate_status`, `event_tags`, `wake_add_rule`, `wake_remove_rule`, `sleep`,
  `wake`, `think`, `journal` and `prose_help` now run for the agent the call
  names and return their answer, where before each failed with "Invalid tool
  name format". `skip_reply` is refused, since the call isn't made in a turn.
  A host that doesn't call these names meets no change.
