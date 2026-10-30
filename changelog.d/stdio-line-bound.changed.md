- **A line longer than 104,857,600 UTF-16 code units (100 Mi) on a stdio
  MCPL server's stdout now ends that server's connection.** This host stops
  reading at the read that takes the line past the bound, writes nothing more
  to the child, and ends it at once with SIGTERM, then SIGKILL if it outlives
  that. Requests in flight fail with the disconnect, and a request made
  before the child exits is refused as not sent. The close's `pipeFailed` is
  `true`, so a server that doesn't reconnect raises `mcpl-down`, as after a
  pipe failure. Each UTF-16 code unit is at least one byte of UTF-8, so such a
  line is also longer than 100 MiB, the per-message bound `ws` 8.22.0's
  client sets on the WebSocket path by default.
- **The `agent-framework-mcp` command exits with code 1** when a line on its
  stdin is longer than the same bound, after one stderr line naming it.
- **The words for a stdio server whose stdio this host stopped using have
  changed.** Where this host's messages said "its pipe failed with X" or "stdio
  pipe failed with X", they now say "this host stopped using the server's
  stdio (X)". A close's reason reads `child process exited, and this host had
  stopped using the server's stdio (write EPIPE)`, and so do the
  `mcpl:server-closed` trace's `reason` and the `mcpl-down` alert that quotes
  it. For a line past the bound, X is "the server wrote a line on stdout
  longer than 104,857,600 UTF-16 code units". A host that matches the old
  words needs the new ones.
