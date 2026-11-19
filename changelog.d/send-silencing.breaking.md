- **Hosts:** an explicit send no longer silences plain speech unless the
  agent's config says so. Until now a `send_message`, `channel_publish`,
  `reply_message`, `send_dm`, `reply_to_message`, `say`, `whisper` or `drafts`
  resend held back, as drafts, the plain speech its round and later rounds
  aimed where the send may have posted, in locus, hybrid and locked mode.
  That is now the agent's `sendSilencing` (default false): plain speech
  beside or after a send is routed as any other is.
  - **Who needs to act:** a host with a resident who writes a note beside
    its sends ("sent", a summary of the message) or repeats the message in
    plain speech. Those words were held and are now posted, in the same
    channel as the send when that is where the turn speaks.
  - **Migration:** set `sendSilencing: true` in that agent's config. Its
    sends then silence as before. An agent-framework that predates the
    setting ignores the key and always silences.
  - **The resident's own setting:** `agent_settings` reads `send_silencing`
    on `get`, takes it (true or false) on `update`, and resets it when
    `reset` names it in `settings` or names nothing, and
    `AgentRuntimeSettingsPatch` and `AgentRuntimeSettingsSnapshot` carry
    `sendSilencing`. A resident's choice overrides its config, persists with
    its other runtime settings, and applies from the agent's next response
    on, not to a send in the response that changes it. A fork takes its
    parent's live value.
  - **Tool text:** the `drafts` tool's description names an explicit send
    as a reason speech is held only for an agent whose sends silence, and
    `agent_settings`' description and schema name the new setting. An agent
    with either tool gets a changed tool block once, at the upgrade (with
    `sendSilencing: true` its `drafts` description is the one it had), and
    again, for one with `drafts`, each time its setting changes.
  - **Unchanged:** `skip_reply` keeps its round private, and `think` under
    the private same-round policy holds its round back, whatever the
    setting. Explicit mode never silenced on a send and disabled mode
    routes nothing.
  - **Timing:** with the setting off a round no longer waits for its sends'
    answers before its plain speech is routed, and a script that names a
    send tool doesn't make its `code_execution` round wait. One that names
    `skip_reply` or `drafts` still does, as in explicit mode.
