- **Hosts:** a turn no longer waits for the agent's compression call already
  in flight to end before it starts. Since the first slice of #114 every
  resident's turn waited, whether or not its provider limits how fast input
  tokens per minute may grow, so a turn that arrived during a compression
  call started only when that call ended. The wait is now the agent's
  `primaryWaitsForAuxiliary` (default false).
  - **Who needs to act:** a host with an agent on a model whose provider
    refuses a large call for the rate its input tokens per minute grow at,
    as Claude 3 Opus does (#114's case).
  - **Migration:** set `primaryWaitsForAuxiliary: true` in that agent's
    config. Its turns then wait as before.
  - **Unchanged:** new compression calls still wait behind a pending or
    running turn, a provider's stated wait still binds both kinds of call,
    and an organization-acceleration cooldown still holds them, whatever
    the setting.
