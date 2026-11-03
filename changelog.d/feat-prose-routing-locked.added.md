- `proseRouting: "locked"`: an agent's plain speech goes to one destination it
  chose, on every turn, and nothing moves it automatically. Not the channel
  that woke the turn, an addressed message, a heartbeat, `channel_open` or the
  host's `speech.locus` rule. The new `prose_locus` tool, offered only to
  locked agents, reads the lock or moves it to a channel (`"#channel"`,
  `"@person"`, an id) or to `"drafts"`, which holds plain speech as drafts.
  A move is stored in `framework/state` and survives restarts. The optional
  `AgentConfig.proseLock` sets the destination until the agent first chooses.
  See docs/locked-prose-routing.md.
