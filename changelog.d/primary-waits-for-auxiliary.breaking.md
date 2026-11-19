- **Hosts:** a turn no longer waits for the agent's compression call already
  in flight to end before it starts. Since the first slice of #114 every
  resident's turn waited, whether or not its provider limits how fast input
  tokens per minute may grow, so a turn that arrived during a compression
  call started only when that call ended. The wait is now the agent's
  `primaryWaitsForAuxiliary` (default false). A turn that starts beside a
  compression call can compile before that call's summary lands, and its
  request is then larger by what the summary would have folded.
  - **Who needs to act:** a host with an agent on a model whose provider
    refuses a large call for the rate its input tokens per minute grow at,
    as Claude 3 Opus does (#114's case); and a host with an agent whose
    budget leaves its model's window no room for a chunk not yet
    summarized, which can pass the window where it fitted before.
  - **Migration:** set `primaryWaitsForAuxiliary: true` in that agent's
    config. Its turns then wait as before. The setting needs no sibling
    version: it is this package's alone, and a host passes it in
    `AgentConfig`. An agent-framework that has the wait (from #114's first
    slice on) and predates the setting ignores the key and always waits, so
    a host on one can set it before it raises its range. The setting is a
    resident's: a conversation agent takes neither side of the provider
    gate, and it does nothing there.
  - **Unchanged:** a new compression call still waits while a turn holds
    admission (from its start to its end, and while a released hold's turn
    is on its way), whatever the setting. A provider's stated wait still
    binds both kinds of call: a turn that starts beside a compression call
    checks the waits again after its compile, so one that call's failure
    records meanwhile holds the turn before anything is sent. That turn
    has begun, so it traces `inference:started` and then `inference:failed`
    with the wait's text, and its retry shows as held in
    `providerAdmission`, as a conversation agent's does. An
    organization-acceleration cooldown or a host's hold still holds the
    turns and compression calls that start after it; one that a compression
    call's failure arms while a turn beside it compiles doesn't stop that
    turn's call, and what that call's own failure does is as for any
    failed call.
