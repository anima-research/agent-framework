- A WebSocket server's close reason no longer reaches the errors a close
  makes. A WebSocket transport that closes during the handshake now fails the
  connect with the transport's words and the close code, such as
  `(websocket closed, code 4001)`, whether or not the server sent a reason,
  and each request pending when the connection drops is rejected with
  `reason=websocket closed`. Previously both errors carried the server's text
  as it wrote it, into the host's log, the `mcpl:server-connect-failed` trace,
  the `mcpl-down` alert and a tool call's result, and the connect error gave
  no code. `mcpl:server-closed` already left that text out. A stdio child's
  exit reads as before.
