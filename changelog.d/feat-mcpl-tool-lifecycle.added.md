- MCPL tool lifecycle (mcpl RFC-007): servers granted `toolLifecycle.observe`
  receive `tools/lifecycle` notifications for the agent's calls to OTHER
  servers' tools and to host tools — `started`, then exactly one of
  `completed` (with `isError`) / `failed` / `aborted`, paired by a host-unique
  `toolCallId`. Metadata only by default; tool results are never sent.
  - `toolLifecycle.inputs` adds the call's arguments, but only the fields a
    server asks for with `tools/observe`, bounded (16 KiB default,
    `toolLifecycle.maxInputBytes`), and never for `comms` or unclassed tools.
  - `tools/observe` (server → host request) sets an ordered first-match
    filter on which calls are reported and which argument fields are sent;
    it only narrows what the grant allows.
  - Both paths are denied by default. Grant them with a
    `McplServerConfig.toolLifecycle` policy block (`observe`, `inputs` with a
    `tools`/`classes`/`conversations` narrowing; `classes: 'default'` admits
    computer, shell, files, web, media and body) or via `enabledCapabilities`.
    `inputs` with no tools/classes term delivers no arguments.
  - `listMcplServers()` shows each connection's current filter.
- MCPL tool classes (mcpl RFC-008): a tool's class is read from
  `_meta["mcpl/class"]` on its MCP definition, from the framework's table of
  its own tools, or from `FrameworkConfig.toolClassOverrides` /
  `hostToolClasses`. Classes are policy hints only: they never change what
  the model sees.
