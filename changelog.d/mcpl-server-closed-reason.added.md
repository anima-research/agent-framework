- The `mcpl:server-closed` trace carries `reason`, why the transport closed,
  in its own words, such as `child process exited, and its pipe failed with
  write EPIPE` or `closed by host`. It is null when the transport gave none,
  and when the reason is a WebSocket server's own close text, which stays off
  the trace: `TransportCloseInfo` and the connection's close info mark that
  text with `reasonFromPeer`.
