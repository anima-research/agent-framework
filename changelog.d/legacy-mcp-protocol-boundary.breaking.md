- **MCPL/MCP server authors:** the legacy engine now enforces the revision it
  speaks. `McplServerConnection` offers MCP `2024-11-05` and now also requires
  it back: an `initialize` result with any other `protocolVersion`, or with
  none, fails as `McplProtocolVersionError` (`kind: 'mismatch'`), stating what
  each side said. Every server family probed answers `2024-11-05`, but a
  hand-written server that omits the field must add it. An `initialize`
  answered with JSON-RPC `-32022` fails as `McplProtocolVersionError`
  (`kind: 'rejected'`), keeping the server's `supported` list, code and data.
  When that list names modern MCP, the message says to configure the server
  with `protocol: 'modern'`. A protocol-version verdict is never retried: no
  reconnect stub, and a reconnecting connection stops its backoff loop
  (`reconnect-failed` carries `permanent: true` and raises the ops alert at
  once). At startup the verdict raises the same `mcpl-down` ops alert, so a
  server refused for its revision doesn't drop out with only a log line. The
  established revision is on `connection.protocolVersion`.
- `tools/list` now follows `nextCursor` across pages, so a paginating server's
  whole inventory reaches the agent; before, every page after the first was
  silently dropped. A repeated cursor, or more than 100 pages, is an error
  rather than a partial inventory.
- **Hosts and operators:** a server configuration with both `command` and
  `url` and no `transport` is now refused before anything is spawned or
  dialed. Before, it was launched as stdio and the url was silently
  ignored. Migration: drop the field you don't use, or set `transport` to
  say which one is used. Unchanged: a configuration with only one of them,
  or with both and a `transport`, resolves as before (a host can still
  layer a url and `transport: 'websocket'` over a file's command). A legacy
  `requestTimeoutMs` above 2^31−1 is refused too: Node ran it as a timer of
  about 1 ms, so every request timed out at once. Every value that worked,
  `0` included, passes.
- **Hosts:** `stop()` now rejects, after its whole teardown, when an MCP
  server's child couldn't be confirmed exited, naming each such child and
  its server. Before, closing a stdio server returned as soon as a signal
  was sent, so `stop()` never failed for this. Code that chains work on
  `stop()`, such as exiting a TUI or switching sessions, should catch that
  rejection: the framework is stopped either way. As with any failed
  teardown, an owned store stays open, and a later `stop()` retries the
  reap, completing once the child has exited.
