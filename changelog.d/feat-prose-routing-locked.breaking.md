- **Hosts:** `AgentConfig.proseRouting` and `Agent.proseRouting` gain
  `'locked'` (locked prose routing, below). A host that switches over either
  exhaustively, or keys a record by it, needs a case for `'locked'`: an
  ephemeral run of a locked agent routes as `'disabled'`, and a conversation
  fork of one as `'locus'`, so a host describing a subagent's routing can
  treat it as one of those.
