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
    and 505, or a network error, each reported as an `error`, and once it
    opens, also when the SDK's own retry after a credential refresh opens
    it, a server that announces list changes is relisted.
    A stream that drops is reopened: the first try waits the server's `retry`
    hint when it sent one, and the base interval otherwise, and a try after a
    failed one waits the longer of the hint and the doubling backoff. A
    reopen with `Last-Event-ID` has what it missed replayed by the server; a
    reopen without one, or one whose id the server refused with 400, relists
    the tools of a server that announces list changes.
  - **A request's stream** that the server closes after a priming event is
    resumed for as long as the request lives, cut again before it carried
    a new event id included: the engine gives back the last id the call's
    resumes carried, which the SDK would leave out
    (modelcontextprotocol/typescript-sdk#2499). A call whose stream ends
    unanswered with nothing to resume from fails then, as `no-response`,
    not at its deadline.
  - **A session the server ends** (HTTP 404 to a request carrying its id,
    but for the standalone stream's first open, whose 404 can also mean the
    server has no GET route): a call whose POST met the 404 fails as
    `error-response` with `data.httpStatus` 404, and isn't replayed; a call
    whose stream was cut is `no-response`. A session that had answered a
    request gets a new one at once, whatever `reconnect` says: `close` while
    `willReconnect` reads true, then `reconnect`, with the server and its
    tools kept. One that ended less than the base interval
    (`reconnectIntervalMs`) after it started does only if the last session
    restarted that way had lived the interval, or there was none. A second
    such young end in a row, or an end before the session answered, is a
    failed connect: it emits `reconnect-failed` and `close`, then follows
    `reconnect`, and the backoff keeps growing, with the framework's alert
    at the fifth attempt, until a session's end starts a new one at once,
    with a session id or without one. Answered sessions that each live
    longer, as behind a load balancer that sends a session's later requests
    to another node, restart at most once an interval, and each restart
    costs the calls in flight.
  - **A server upgraded in place** to `2026-07-28` is followed: a 400
    carrying JSON-RPC `-32022` to any request, or a 405 to a GET for one of
    the session's streams after the server had served it (the standalone
    stream's reopen, or a request stream's resume), ends the session as a
    404 does, and the new connect negotiates afresh. These are how the SDK's
    2026 handler answers 2025 traffic it refuses (`legacy: 'reject'`) or
    serves statelessly (its default). A call refused with `-32022` fails as
    `error-response` with the server's data, its code in the host's log,
    and isn't replayed. A connection that never had a standalone stream, to
    a server that serves 2025 statelessly, stays on 2025 until its next
    connect, unless the upgrade cut a call's stream, whose resume then meets
    the 405.
  - **A `DELETE`** ends each session the server holds by its id when the
    connection lets it go, waiting at most 3 s: at `close()`, a connect in
    flight included, and when a connect fails after its `initialize` was
    answered. A session the server let go, with a 404, a `-32022` or such a
    405, gets none.
  - **Results** are final: a result that fails the tool's output schema is a
    plain error, as on `2026-07-28`, not a `no-response` outcome.
- **`McplProtocolVersionError` over HTTP** names the revisions each side
  speaks. Its new `offeredRevisions` lists the revisions this client
  offered: `['2024-11-05']` from the legacy engine, `['2026-07-28']` from a
  modern stdio server, and the four revisions above over HTTP. `offered`
  stays the first of them. Besides the SDK's own refusal of a discovery or
  a `-32022` error, after which it negotiates no further, it covers an
  `initialize` answered with a revision the 2025 handshake doesn't accept
  (`2026-07-28` included), or with none (`mismatch`), and a discovery that
  listed no revision in common followed by an `initialize` the server
  refused (`rejected`). It isn't retried. A handshake that failed any other
  way, such as with a 503, is no verdict, and is retried as any failed
  connect is.
