- **Operators:** an MCPL server this host won't connect again on its own now
  raises the `mcpl-down` ops alert once: a `failures.log` record, an
  `ops:alert` trace, and the webhook within its 15-minute throttle.
  - A startup connect that fails, leaving nothing connected and nothing to
    retry it: a server without `reconnect: true`, a configuration refused
    before anything launches, a protocol-version verdict, or a launch that
    couldn't be reaped. 0.28.0 alerted only for the last two, so a stdio
    server that exited before its handshake, as one started before the
    network is up does, left one stderr line and its traces, and no alert.
    The alert now reads "MCPL server not connected at startup, and this host
    won't retry it on its own: <error>", where 0.28.0's read "MCPL server
    unreachable at startup: <error>". A startup failure that leaves a
    retrying connection raises nothing at startup: its fifth failed retry
    raises the alert, or a retry that fails for good does, as before.
  - A connected server that closes on its own with no reconnect coming: "MCPL
    server closed (<reason>, code <n>), and this host won't reconnect it on its
    own", with the transport's own reason and its exit or close code or signal
    (a WebSocket peer's close text is left out, as the trace leaves it out), or
    "MCP server closed (<reason>, code <n>), …" for a modern server. 0.28.0
    raised nothing. A close this host makes (`stop()`, `disconnectMcplServer`,
    `restartMcplServer`) raises none, and neither does a loss once `stop()` has
    begun, whatever its cause, since it is part of the close the host is
    making. Nor does a loss that reconnects, nor one whose launch couldn't be
    reaped, which already raises the alert.
  - A child that ends the way a server ends when asked to is taken as stopped,
    not lost, and raises none: an exit with code 0, death by SIGTERM, SIGINT
    or SIGHUP, or a shell's report of such a death, exit code 143, 130 or 129.
    A service manager's stop (systemd's default, for one) signals the host and
    its children together, so a child can go before the host's `stop()` closes
    it, and a server that catches SIGTERM may exit 0 instead. So a connected
    server that exits 0, or with one of those codes, on its own isn't
    reported. Any other exit code, SIGKILL, SIGABRT or any other signal still
    alerts, and so does a child the stdio transport ended itself after an
    error on the child's stdin or stdout, whatever its code or signal. After
    such an error the transport now waits up to 2 seconds for the child to
    exit on its own before ending it, so a child that was already gone, as
    one a stop's signal reaches while the host is writing to it, closes with
    its own code and signal. A live child whose pipe failed is ended up to 2
    seconds later than in 0.28.0; its connection is unusable by then.
- **Operators:** a modern stdio server's loss now carries its child's exit
  code and signal, as a legacy server's does: the `mcpl:server-closed` trace
  carries them, where 0.28.0 gave `null` for both, and its `reason`, which
  0.28.0 left out, is "child process exited" where the loss read "transport
  closed".
- **Operators:** a modern stdio server whose connect fails now carries the
  last of the child's stderr, redacted, as a legacy server's failure does. A
  failed first connect's "Failed to connect MCPL server" or "initial connect
  failed, will retry" line prints it, and the `mcpl:server-connect-failed`
  trace carries it as `stderrTail`, for the first connect and for each failed
  retry. The alert leaves it out, since the webhook posts outside the process.
  0.28.0's lines gave only the SDK's error, such as "Version negotiation probe
  failed: Connection closed during the version negotiation probe", and the
  child's stderr only as `mcpl:server-stderr` traces.
- **Hosts:** `restartMcplServer`'s doc no longer says that `reconnect: true`
  doesn't respawn a stdio child: each reconnect attempt spawns the child
  afresh, once the connection has failed or the child has exited.
