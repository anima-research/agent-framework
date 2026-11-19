- **Hosts:** an explicit send no longer silences plain speech unless the
  agent's config says so. Until now a `send_message`, `channel_publish`,
  `reply_message`, `send_dm`, `reply_to_message`, `say`, `whisper` or `drafts`
  resend held back, as drafts, the plain speech its round and later rounds
  aimed where the send may have posted, in locus, hybrid and locked mode.
  That is now the agent's `sendSilencing` (default false): plain speech
  beside or after a send is routed as any other is.
  - **Who needs to act:** a host with an agent, a resident or an ephemeral
    one, that writes a note beside its sends ("sent", a summary of the
    message) or repeats the message in plain speech. Those words were held
    and are now posted, in the same channel as the send when that is where
    the turn speaks.
  - **Migration:** set `sendSilencing: true` in that agent's config. Its
    sends then silence as before. An agent-framework that predates the
    setting ignores the key and always silences. The setting needs no
    sibling version. A host that builds `AgentConfig` from its own
    configuration needs to pass the key: connectome-host does from the
    release that takes `agent.sendSilencing` in a recipe, and an earlier
    one refuses the key as unknown, so on it the setting can be turned on
    only by the agent itself, through `agent_settings`. Either package can
    be upgraded first.
  - **The resident's own setting:** `agent_settings` reads `send_silencing`
    on `get`, takes it (true or false) on `update`, and resets it when
    `reset` names it in `settings` or names nothing, and
    `AgentRuntimeSettingsPatch` and `AgentRuntimeSettingsSnapshot` carry
    `sendSilencing`. A resident's choice overrides its config, persists with
    its other runtime settings (`sendSilencing` is a required field of the
    snapshot type, so a typed fixture or mock of one needs it), and applies
    to sends from the agent's next
    response on at the latest (a send made directly in the response that
    changes it is counted under the old value). Turning it off doesn't undo
    a hold an earlier send in the turn already set. A fork takes its
    parent's live value.
  - **Tool text:** the `drafts` tool's description names an explicit send
    as a reason speech is held only for an agent whose sends silence, and
    `agent_settings`' description and schema name the new setting. At the
    upgrade the tool block changes for an agent that has `agent_settings`,
    and for one that has `drafts` unless its `sendSilencing` is true (its
    description is then the one it had). An agent with `drafts` gets a
    changed block again each time its setting changes. A changed block
    misses the provider's prompt cache once, and a fork whose setting
    differs from its parent's doesn't share the parent's cached prefix.
  - **Unchanged:** `skip_reply` keeps its round private, and `think` under
    the private same-round policy holds its round back, whatever the
    setting. Explicit mode never silenced on a send and disabled mode
    routes nothing.
  - **Timing:** with the setting off a round no longer waits for its sends'
    answers before its plain speech is routed, and a script that names a
    send tool doesn't make its `code_execution` round wait. One that names
    `skip_reply` or `drafts` still does, as in explicit mode.
