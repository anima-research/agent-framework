- **Hosts and operators of MCPL servers that advertise RFC-014 tool hints:**
  tool hints are now on by default. An MCPL server whose configuration
  leaves `toolHints` out (or sets it null) is offered
  `experimental.mcpl.toolHints`, as one set to `true` was, so a server that
  advertises hints too has its toolset and dynamic tools leave the API tool
  list: they're announced in the conversation and reached through
  `toolsets--open` and `toolsets--act`, and a call of one by its listed name
  is refused while it isn't static. `toolHints: false` is the per-server
  opt-out. A server added any way, including at runtime by a deploy tool
  that doesn't name the setting, gets toolsets.
  - **Migration:** to keep a server's whole tool list as 0.28.0 gave it, set
    `toolHints: false` on it. (The agent's tool list as a whole changes in
    this release anyway: see the host's own toolsets, below.)
  - **Who else notices:** the `toolsets` module's four meta-tools
    (`toolsets--open`, `--act`, `--look`, `--close`) are in every agent's tool
    list from creation, with or without MCPL, since the host's own toolsets
    use them too; the first request after the update writes its prompt cache
    in full.
  - **Unchanged:** a server that doesn't advertise hints lists every tool as
    before. A modern (MCP) server can't negotiate hints, so it has none, and
    `toolHints: true` on one is still refused. Where a module given to
    `create()` holds the name `toolsets`, MCPL servers that leave the setting
    out have no hints, and a line names them. A server whose `toolPrefix` is
    `toolsets` is refused, at startup and at runtime, and so is a host's own
    `addModule()` of a module named `toolsets`: the name is the framework's
    from creation.
