- **Operators:** once `stop()` has begun, no MCPL server with `reconnect: true`
  is launched or dialed again on its own. A server lost just before or during
  a stop, as when a service manager signals the host and its children
  together, kept its retry timer, so when `stop()`'s waits (a stream, a
  script, an operator operation) outlasted the retry's delay, 3.75 to 6.25
  seconds at the defaults, its stdio command was started again and could
  reconnect before the teardown closed it. A server such as a Discord bridge
  logs in to its service before it serves, so that start did outward work for
  nothing. Now `stop()`'s first step stops every connection reconnecting: a
  retry already scheduled starts nothing, none is scheduled after, and a
  legacy retry already under way is aborted, so one still waiting on its
  access provider never dials. A modern retry already under way has spawned
  its child or opened its connection, and is ended by the teardown's close,
  as before. This covers a server whose first connect failed too: its
  background retries stop as well.
