- Modern MCP servers (revision `2026-07-28`) can now be configured beside
  MCPL ones, through the official SDK 2.x client. A server's URL decides its
  family: `ws://`/`wss://` stays MCPL (MCP `2024-11-05`), and
  `http://`/`https://` is modern MCP over Streamable HTTP. A stdio server
  stays legacy unless its config sets `protocol: 'modern'`. A modern server's
  tools use the same prefix, tool policy, RFC-008 class hints and dispatch
  paths as any MCPL server's, and its tool prefix meets the same rules: it
  can't be a module's name or another server's prefix, or meet another
  server's, whichever family either server is. It has no MCPL surface: no grant, push,
  channels, inference requests, quiesce plane or awareness gate. MCPL policy
  that asks for that surface on one is a configuration error, such as
  `allowHostCommands: true` or a scope's non-empty `whitelist`. Policy that
  only takes something away or repeats a default, such as
  `disabledCapabilities` or an allow-list like `enabledFeatureSets`, is
  accepted as already satisfied, so a host that puts a deny-list on every
  server it deploys can deploy a modern one. A modern `requestTimeoutMs`
  outside 1..2^31−1 is a configuration error too, since 0 means "time out
  now" to the SDK. Details:
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
    plain error. The message an agent reads is the one an MCPL server's
    failure gives where the two share an outcome, and has its shape where
    they don't: what happened, whether anything took effect, and what works
    from there. The method, the tool, the JSON-RPC code and the HTTP status
    go to the host's log. A tool call made while the server's connect is
    still under way reads as one made while an MCPL server connects.
  - **Lifetime:** reconnects use the legacy backoff settings. A tool-list
    change subscription is kept open, reopened if refused or lost, and its
    changes go through ordinary admission, so they park under quiesce like
    any wake. `close()` and `stop()` end any connect in flight. A
    `ModernMcpConnection` starts once: a second `start()` returns the first
    call's promise. When a stdio launch's first attempt fails and its cleanup
    can't confirm the child exited, `ModernMcpConnection.connect()` throws
    `McplUnreapedLaunchError`, whose `connection` owns the launch; its
    `close()` retries the reap.
  - **Status:** `listMcplServers()` entries gain `family`, `protocolVersion`
    and `transport`.
- A server lost for good (it closed and won't reconnect), MCPL or modern,
  now leaves the agents' tool list, as a disconnected one does. So does one
  whose reconnecting halts for good (`reconnect-failed` with
  `permanent: true`, which also raises the ops alert). An MCP tool
  result marked as an error is traced as `tool:failed`, on both engines.
