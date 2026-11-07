- **On `2026-07-28` over HTTP**, a dropped stream's retries take the same
  timing as on a 2025 revision: the server's `retry` hint first, and the
  connection's backoff after a failed try. They stop after two failed tries,
  the SDK's default, on every stream: a listen stream that can't be resumed
  is reopened, with a relist, and a call whose stream can't be resumed fails
  then, as `no-response`, rather than at its deadline.
- **A modern stdio server** whose discovery answer lists revisions without
  `2026-07-28` is a `McplProtocolVersionError` (`rejected`) that isn't
  retried, even when the SDK can't read the answer as a discovery result.
  Such an answer the SDK couldn't read was an ordinary failed connect.
