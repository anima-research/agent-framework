- `StdioTransport.close()` resolves for a child that a signal other than its
  own `kill()` has already ended, such as an OOM kill or a crash. It waited
  for an `exit` event that had already fired. So a connect or reconnect whose
  child died that way during `initialize` never settled, `close()` on its
  connection never settled, and `stop()` failed when its teardown timeout ran
  out (#331).
- An error an MCPL transport reports while nothing else listens for it is
  now logged instead of thrown as an uncaught exception. That covers a
  transport that `McplServerConnection` keeps for `close()` while a
  reconnect's handshake finishes (#332), a transport whose handshake has
  settled until the connection takes it, and one that a failed handshake is
  closing. A malformed frame from a WebSocket server is such an error.
- A failed write to a stdio child's stdin, such as EPIPE from a child that
  has gone, reaches the transport's `'error'` listener if it has one and is
  otherwise dropped, since the child's exit is reported anyway. It was thrown
  as an uncaught exception. So was a read error on the child's stdout or
  stderr, which is now handled the same way.
