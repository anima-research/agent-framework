- `AgentSettingsExtension.validate(agentName, patch)`, optional, refuses an
  update before anything in the `agent_settings` call is applied. An extension
  without it is checked only by its `update`, so `agent_settings` applies such
  extensions before everything else in the call. If one refuses after another
  such extension had applied, the error names what changed ("Changed before
  the refusal: …").
