- **A tool call whose arguments JSON can't write is refused as not sent
  (`not-sent`), in both engines** (#556). Such arguments, a BigInt or a
  cyclic object, can come only from in-process code. The modern engine
  reported the call as possibly executed (`no-response`: "whether it took
  effect is unknown"), though nothing reached the server. The legacy engine
  already refused it, but said to try again later, which fails the same way.
  Both now say "If calling it again fails, ask whoever runs this host", and
  the host's log line names the serializer's error.
- **A legacy request refused as not sent stays a `not-sent` refusal when the
  host's `console.error` throws:** for these arguments, for a stdio pipe
  that has failed, and for a write the transport refuses at once. Before,
  the call threw the logger's error, or failed with it. The refusal's log
  line is then lost.
- **A request that fails over HTTP is reported once** (#556), by whatever
  made it: a tool call or a listing to its caller and in the host's own log
  line. Its failure no longer also raises the modern connection's `'error'`
  event, and with it the framework's `mcpl:server-error` trace. A host that
  logs that trace, as connectome-host does in each server's `mcpl-stderr`
  log, no longer shows a failed tool call there; its HTTP status and the
  server's words stay in the host's own log line. A failed listing still
  shows there once, as the framework's `tools/list failed` trace, and so
  does a failure the SDK reports itself, such as a list-change
  subscription's. A connection with no `'error'` listener of the host's no
  longer logs a second line for it. A failed notification is reported as
  before, since what sent it may report nothing of it.
- **A stdio MCP server whose pipe fails and whose child outlives SIGKILL no
  longer has calls told that the host is reconnecting to it** (from the
  review of #540). The modern engine now holds the launch before the calls
  the failure ends are answered, as the legacy engine does, so they, and a
  call made as the connection closes, read that the host won't reconnect to
  it on its own.
- **A legacy stdio server the framework launched no longer has the Discord
  awareness ledger read from disk for each JSON-RPC error answer's log
  line** (from the review of #540). The connection builds that line's
  redaction at its first error answer and keeps it. If the ledger can't be
  read when it builds, that line is withheld, and the next answer builds
  again.
