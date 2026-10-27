- MCPL RFC-014 tool hints are on by default. A server whose configuration
  leaves `toolHints` out (or sets it null) is offered
  `experimental.mcpl.toolHints` and gets toolsets and dynamic tools when it
  advertises hints too, as one set to `true` did; `toolHints: false` is the
  per-server opt-out. So a server added any way, including at runtime by a
  deploy tool that doesn't name the setting, gets them. A server that doesn't
  advertise hints lists every tool as before. The `toolsets` module's four
  meta-tools (`toolsets--open`, `--act`, `--look`, `--close`) are registered
  when any server has hints, so an agent with an MCPL server whose hints
  aren't off sees four more tools, and its first request after the update
  writes its prompt cache in full; `toolHints: false` on every server keeps
  0.28.0's tool list byte for byte.
  - A configuration that loaded before still loads: where the name
    `toolsets` is held at startup, by a module or by a server's
    `toolPrefix`, servers that leave the setting out have no hints, and a
    line says so. `toolHints: true` reserves the name as before.
  - At runtime, while the meta-tools are registered, a server whose
    `toolPrefix` is `toolsets` is refused, as it was in 0.28.0 while any
    server had `toolHints: true`.
  - A modern (MCP) server can't negotiate hints, so it's offered none, and
    `toolHints: true` on one is still refused.
