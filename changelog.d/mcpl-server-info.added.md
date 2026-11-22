- **`listMcplServers()` gives each server's own name and version** as
  `serverInfo`: the `name` and the `version` that the last handshake of the
  server's connection gave in MCP's `serverInfo`, each null where it gave
  none. Each is the server's text: redacted as the server's other text is,
  kept to one line, and with each opening of a framework notice tag marked.
  `serverInfo` is null when that handshake gave neither, and while the
  server has no connection that has made a handshake: before its first one,
  and once its connection is gone, as for a closed tab. A later handshake,
  such as a reconnect's, replaces it. `McplServerConnection` and
  `ModernMcpConnection` have it as `serverInfo` too, and the package exports
  its type, `McpServerInfo`. The legacy engine reads it from the
  `initialize` answer, and the modern engine from its client's handshake,
  where a server on MCP 2026-07-28 may give none.
