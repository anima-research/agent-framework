- A connect or reconnect whose stdio server fails its handshake, by exiting,
  by a transport error or by not answering in time, such as a server that
  exits at startup for want of a token, now keeps the last of the server's
  stderr: at most 2,048 UTF-16 code units, after a `…` when earlier output
  was dropped. The error named only how the handshake failed, and what the
  server wrote about why was dropped (#339). The stderr stays out of the
  error's message, which travels wherever errors go, tool results included,
  since a server's stderr can hold a credential. The error carries it as
  `stderrTail`, the connection's `'connect-failed'` and `'reconnect-failed'`
  events carry it beside `error`, the host's log line about the failure
  prints it a line at a time, and the `mcpl:server-connect-failed` trace
  carries it as `stderrTail`. The `mcpl-down` ops alert, which posts to the
  operator's webhook, leaves it out. An `initialize` error answer, where the
  server gives its own reason, is unchanged.
- A stdio server's last stderr line, when it has no newline, is now emitted
  as a `'stderr'` line once the stream ends. It was kept until more output
  completed it, so it never arrived (#339).
- A stdio server's stderr is decoded as one stream, so a character whose
  bytes arrive in two reads is no longer replaced with U+FFFD in its line.
