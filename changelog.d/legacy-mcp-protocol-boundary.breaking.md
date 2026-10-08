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
  once). The established revision is on `connection.protocolVersion`.
- `tools/list` now follows `nextCursor` across pages, so a paginating server's
  whole inventory reaches the agent; before, every page after the first was
  silently dropped. A repeated cursor, or more than 100 pages, is an error
  rather than a partial inventory.
