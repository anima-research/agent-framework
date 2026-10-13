- Modern MCP servers over `http://` or `https://` can now be on a 2025
  revision (`2025-11-25`, `2025-06-18` or `2025-03-26`) as well as
  `2026-07-28`. The revision is negotiated at each connect: `server/discover`
  first, then the 2025 `initialize` handshake when the server doesn't offer
  `2026-07-28`, so a server's upgrade is followed at its next connect.
  `listMcplServers()` shows the negotiated revision as `protocolVersion`, and
  the `family` stays `modern`. A modern stdio server stays pinned to
  `2026-07-28`. On a 2025 revision:
  - **List changes** arrive on the session's standalone stream. A stream that
    drops is reopened for as long as the session lives, with the reconnect
    backoff and never sooner than the server's `retry` hint asks, and each
    reopen relists the server's tools.
  - **A session the server ends** (HTTP 404 to a request carrying its id):
    the request that met the 404 fails as `error-response` with
    `data.httpStatus` 404, and isn't replayed. A session that had answered a
    request gets a new one at once, whatever `reconnect` says. One that hadn't
    is a failed connect: it emits `reconnect-failed` and `close`, then follows
    `reconnect`, and the backoff keeps growing until a session answers.
  - **`close()`** ends a live session with a `DELETE`, waiting at most 3 s.
  - **Results** are final: a result that fails the tool's output schema is a
    plain error, as on `2026-07-28`, not an unknown outcome.
- **`McplProtocolVersionError` over HTTP** names the revisions each side
  speaks, and `offered` is the list this client offered: `['2024-11-05']`
  from the legacy engine, `['2026-07-28']` from a modern stdio server, and
  the four revisions above over HTTP. Besides a discovery or `-32022` error
  naming no revision in common, it covers an `initialize` answered with a
  revision this client doesn't offer, or with none (`mismatch`), and a
  discovery that listed no revision in common followed by a failed
  `initialize` (`rejected`). It isn't retried.
