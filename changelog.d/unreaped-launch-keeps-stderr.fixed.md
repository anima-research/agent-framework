- At startup, a failed MCPL connect whose launch couldn't be reaped, or
  that `stop()` or a disconnect ended, now keeps the server's stderr that
  its handshake's error kept in its `mcpl:server-connect-failed` trace and
  its `Failed to connect MCPL server` console line, redacted, as other
  failed connects do. The handshake's error carries the stderr as
  `stderrTail`, and `McplUnreapedLaunchError` and the framework's own
  refusals wrap that error, so the trace and the line, which read only the
  outermost error, found none.
