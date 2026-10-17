- An error on a stdio MCPL child's stdin or stdout, such as a write's EPIPE
  from a child that closed its stdin but kept running, is now handled as the
  end of that child. Those pipes carry the protocol, so the transport sends
  the child SIGTERM if it's still running, and when the child exits, the
  transport's close names the error (`child process exited, and its pipe
  failed with write EPIPE`), unless the host had closed the transport first.
  The connection handles that close as any other exit: it rejects its pending
  requests, and reconnects if `reconnect` is set. Such an error used to reach
  only the transport's `'error'` listener, while the connection stayed
  connected and each request waited out its timeout. A child that ignores
  SIGTERM keeps running, and its requests still wait out their timeouts. A
  read error on the child's stderr still reaches the `'error'` listener if
  there is one: once the connection is wired it ends nothing, and during a
  handshake it fails the handshake.
