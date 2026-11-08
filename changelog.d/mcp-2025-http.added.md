- Modern MCP servers over `http://` or `https://` can now be on a 2025
  revision (`2025-11-25`, `2025-06-18` or `2025-03-26`) as well as
  `2026-07-28`. The revision is negotiated at each connect, and
  `listMcplServers()` shows it as `protocolVersion`, with the `family` still
  `modern`. A modern stdio server stays pinned to `2026-07-28`.
- **A 2025 session the server ends** gets a new one at once, whatever
  `reconnect` says, with the server and its tools kept, and costs the calls
  in flight: a call whose request met the server's 404 didn't run, and fails
  as `error-response` with `data.httpStatus` 404; one whose stream was cut
  may have run, and is `no-response`. A session that ends before it
  answered a request, or the second session in a row to end within
  `reconnectIntervalMs` of starting, is a failed connect instead: it emits
  `reconnect-failed`, follows `reconnect`, and counts toward the framework's
  alert at the fifth attempt.
- **`McplProtocolVersionError` over HTTP** names the revisions each side
  speaks. It isn't retried. A handshake that failed any other way, such as
  with a 503, is retried as any failed connect is.
- **`McplProtocolVersionError`'s new `offeredRevisions`** lists every
  revision this client offered, with `offered` still the first of them: the
  legacy engine's one, a modern stdio connection's one, or a modern
  connection's list over HTTP.
