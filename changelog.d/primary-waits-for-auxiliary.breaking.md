- **Hosts:** a turn no longer waits for the agent's compression call already
  in flight to end before it starts. Since the first slice of #114 every
  resident's turn waited, whether or not its provider limits how fast input
  tokens per minute may grow, so a turn that arrived during a compression
  call started only when that call ended. The wait is now the agent's
  `primaryWaitsForAuxiliary` (default false). A turn that starts beside a
  compression call compiles before that call's summary lands, so its
  request is larger by what the summary would have folded: an agent whose
  budget leaves its model's window no room for that can pass the window
  where it fitted before.
  - **Who needs to act:** a host with an agent on a model whose provider
    refuses a large call for the rate its input tokens per minute grow at,
    as Claude 3 Opus does (#114's case).
  - **Migration:** set `primaryWaitsForAuxiliary: true` in that agent's
    config. Its turns then wait as before. The setting needs no sibling
    version: it is this package's alone, and a host passes it in
    `AgentConfig`. An agent-framework before this release ignores the key
    and always waits, so a host can set it before it raises its range.
    The setting is a resident's: a conversation agent takes neither side
    of the provider gate, and it does nothing there.
  - **Unchanged:** new compression calls still wait behind a pending or
    running turn, whatever the setting. A provider's stated wait still
    binds both kinds of call: a turn that starts beside a compression call
    checks the waits again after its compile, so one that call's failure
    records meanwhile holds the turn before anything is sent. An
    organization-acceleration cooldown or a host's hold still holds the
    turns and compression calls that start after it; one that a compression
    call's failure arms while a turn beside it compiles doesn't stop that
    turn's call, and what that call's own failure does is as for any
    failed call.
