- Modern MCP servers (revision `2026-07-28`) can now be configured beside
  MCPL ones, through the official SDK 2.x client. A server's URL decides its
  family: `ws://`/`wss://` stays MCPL (MCP `2024-11-05`), and
  `http://`/`https://` is modern MCP over Streamable HTTP. A stdio server
  stays legacy unless its config sets `protocol: 'modern'`. A modern server's
  tools use the same prefix, tool policy, RFC-008 class hints and dispatch
  paths as any MCPL server's. It has no MCPL surface: no grant, push,
  channels, inference requests, quiesce plane or awareness gate. MCPL-only
  policy on one is a configuration error, and so is a modern
  `requestTimeoutMs` outside 1..2^31−1, since 0 means "time out now" to the
  SDK. Details:
  - **stdio:** runs through the framework's own spawner (env allowlist,
    `inheritEnv`, stderr lines including startup), launched once per connect.
  - **HTTP credentials:** come from `token`/`accessProvider`, as a cached
    bearer refreshed once on 401.
  - **Deadline:** each call gets one `requestTimeoutMs` deadline across every
    leg and the pauses between them. At the deadline cancellation is
    requested for a leg in flight (between continuation rounds none is), the
    outcome is reported as unknown, and nothing is replayed.
  - **Failures:** reported as `McplRequestError`, with the outcome taken from
    what actually crossed the transport: `not-sent`, `error-response` (HTTP
    401/403 with `data.httpStatus`) or `no-response`. Only an error or a
    `complete` result is a final answer: a call that ends after an
    `input_required` answer, or after a result type this revision doesn't
    define, is `no-response`. A complete result that can't be used is a
    plain error.
  - **Lifetime:** reconnects use the legacy backoff settings. A tool-list
    change subscription is kept open, reopened if refused or lost, and its
    changes go through ordinary admission, so they park under quiesce like
    any wake. `close()` and `stop()` end any connect in flight. A
    `ModernMcpConnection` starts once: a second `start()` returns the first
    call's promise.
  - **Status:** `listMcplServers()` entries gain `family`, `protocolVersion`
    and `transport`.
