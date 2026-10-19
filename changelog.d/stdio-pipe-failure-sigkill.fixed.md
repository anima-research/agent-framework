- **A stdio MCP server whose stdin or stdout fails is now ended even when
  it ignores SIGTERM, in both engines.** Since 0.22.2 such a failure sends
  the child SIGTERM, and its exit closes the connection. A child that
  ignored SIGTERM kept running, the connection stayed connected, and each
  request waited out its timeout. The transport now sends SIGKILL after 2 s,
  as its `close()` does, in the one attempt `close()` shares, so the
  connection closes, and reconnects if it would after any exit, its close
  still naming the pipe's error.
  - Nothing more is written to the child after the failure. A request made
    then is refused as not sent (`not-sent`), where it was written to the
    failed pipe and reported at its deadline as possibly executed. One
    written before the failure is still reported as possibly executed.
  - A connected server's child that outlives SIGKILL too is held as a
    launch that couldn't be reaped, as a reconnect holds one: reconnecting
    halts, the `mcpl-down` alert is raised, its tools leave the agents'
    list, and its id stays held until a disconnect or `stop()` retries the
    reap and confirms the exit.
  - Under Bun, a child that closes its stdin isn't reported at all, since
    Bun emits no `'error'` event for the writes to it, so request timeouts
    still bound it, as they do a child that stops reading.
