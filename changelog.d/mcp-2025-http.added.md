- Modern MCP servers over `http://` or `https://` can now be on a 2025
  revision (`2025-11-25`, `2025-06-18` or `2025-03-26`) as well as
  `2026-07-28`. The revision is negotiated at each connect: `server/discover`
  first, then the 2025 `initialize` handshake when the server doesn't offer
  `2026-07-28`.
  `listMcplServers()` shows the negotiated revision as `protocolVersion`, and
  the `family` stays `modern`. A modern stdio server stays pinned to
  `2026-07-28`. On a 2025 revision:
  - **List changes** arrive on the session's standalone stream, which is kept
    open while the session lives, with a session id or without one. Its
    first open is tried again after a 408, 409, 429, a 5xx other than 501
    and 505, or a network error, each reported as an `error`, and a relist
    follows once it opens, also when the SDK's own retry after a credential
    refresh opens it.
    A stream that drops is reopened: the first try waits the server's `retry`
    hint when it sent one, and the base interval otherwise, and a try after a
    failed one waits the longer of the hint and the doubling backoff. A
    reopen with `Last-Event-ID` has what it missed replayed by the server; a
    reopen without one, or one whose id the server refused with 400, relists
    the tools of a server that announces list changes.
  - **A request's stream** that the server closes after a priming event is
    resumed for as long as the request lives.
  - **A session the server ends** (HTTP 404 to a request carrying its id):
    a call whose POST met the 404 fails as `error-response` with
    `data.httpStatus` 404, and isn't replayed; a call whose stream was cut is
    `no-response`. A session that had answered a request gets a new one at
    once, whatever `reconnect` says: `close` while `willReconnect` reads
    true, then `reconnect`, with the server and its tools kept. One that
    hadn't is a failed connect: it emits `reconnect-failed` and `close`, then
    follows `reconnect`, and the backoff keeps growing until a session
    answers, with a session id or without one.
  - **A server upgraded in place** to `2026-07-28` is followed: a 400
    carrying JSON-RPC `-32022` to any request, or a 405 to the standalone
    stream's reopen after it had opened, ends the session as a 404 does, and
    the new connect negotiates afresh. These are how the SDK's 2026 handler
    answers 2025 traffic it refuses (`legacy: 'reject'`) or serves
    statelessly (its default). A call refused with `-32022` fails as
    `error-response` with the server's code and data, and isn't replayed. A
    connection that never had a standalone stream, to a server that serves
    2025 statelessly, stays on 2025 until its next connect.
  - **A `DELETE`** ends each session the server holds by its id when the
    connection lets it go, waiting at most 3 s: at `close()`, a connect in
    flight included, and when a connect fails after its `initialize` was
    answered. A session the server ended with 404 gets none.
  - **Results** are final: a result that fails the tool's output schema is a
    plain error, as on `2026-07-28`, not an unknown outcome.
- **On `2026-07-28` over HTTP**, a dropped stream's retries take the same
  timing as on a 2025 revision: the server's `retry` hint first, and the
  connection's backoff after a failed try. They still stop after two, so a
  listen stream that can't be resumed is reopened, with a relist.
- **`McplProtocolVersionError` over HTTP** names the revisions each side
  speaks, and `offered` is the list this client offered: `['2024-11-05']`
  from the legacy engine, `['2026-07-28']` from a modern stdio server, and
  the four revisions above over HTTP. Besides a discovery or `-32022` error
  naming no revision in common, it covers an `initialize` answered with a
  revision the 2025 handshake doesn't accept (`2026-07-28` included), or
  with none (`mismatch`), and a discovery that listed no revision in common
  followed by an `initialize` the server refused (`rejected`). It isn't
  retried. Over stdio, a discovery answer listing revisions without
  `2026-07-28` is a verdict too, even one the SDK can't read.
