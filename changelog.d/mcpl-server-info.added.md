- **`listMcplServers()` gives each server's own name and version** as
  `serverInfo`: the `name` and the `version` that the server's last
  handshake gave in MCP's `serverInfo`, each null where it gave none. Each
  is the server's text, redacted as the server's other text is and kept to
  one line. `serverInfo` is null when that handshake gave neither, and while
  no connection to the server has made a handshake. A later handshake, such
  as a reconnect's, replaces it. The legacy engine reads it from the
  `initialize` answer, and the modern engine from its client's handshake,
  where a server on MCP 2026-07-28 may give none.
