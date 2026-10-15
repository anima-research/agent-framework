- `AgentSettingsExtension.validate(agentName, patch)`, optional, refuses an
  update before anything in the `agent_settings` call is applied. Its `patch`
  holds only this extension's keys, as `update`'s does. An extension without
  it is checked only by its `update`, so `agent_settings` applies such
  extensions first in an update, before the core settings and the extensions
  that checked ahead; if one refuses after something applied, the refusal
  names what changed.
