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
    `toolHints: false` on it; on every server, it also keeps 0.28.0's tool
    list byte for byte.
  - **Who else notices:** an agent with an MCPL server whose hints aren't off
    sees the `toolsets` module's four meta-tools (`toolsets--open`, `--act`,
    `--look`, `--close`), registered at startup or at that server's first
    runtime connect, and its first request after the update writes its prompt
    cache in full.
  - **Unchanged:** a server that doesn't advertise hints lists every tool as
    before. A modern (MCP) server can't negotiate hints, so it has none, and
    `toolHints: true` on one is still refused. A configuration that loaded on
    0.28.0 still loads: where the name `toolsets` is held at startup, by a
    module or by a server's `toolPrefix`, MCPL servers that leave the setting
    out have no hints, and a line names them; `toolHints: true` reserves the
    name as before. At runtime, while the meta-tools are registered, a server
    whose `toolPrefix` is `toolsets` is refused, as it was in 0.28.0 while any
    server had `toolHints: true`.
