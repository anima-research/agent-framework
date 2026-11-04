- `proseRouting: "locked"`: an agent's plain speech goes to one destination it
  chose, on every turn, and nothing moves it automatically. Not the channel
  that woke the turn, an addressed message, a heartbeat, `channel_open` or the
  host's `speech.locus` rule. The new `prose_locus` tool, offered only to
  locked agents, reads the lock or moves it to a channel (`"#channel"`,
  `"@person"`, an id) or to `"drafts"`, which holds plain speech as drafts.
  A move is stored in `framework/state` and survives restarts. The optional
  `AgentConfig.proseLock` sets the destination until the agent first chooses.
  An earlier agent-framework doesn't support the mode: it routes the speech
  as `locus` but tells the agent it's in explicit mode, and doesn't silence
  speech beside a send. Upgrade agent-framework before any recipe sets it; connectome-host needs
  its companion release (anima-research/connectome-host#603) to accept it in
  a recipe. Agents that don't set the mode route as before. See
  docs/locked-prose-routing.md.
