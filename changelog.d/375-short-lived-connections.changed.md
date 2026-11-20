- The reconnect backoff's count of failed attempts now starts afresh only
  once a connection has lasted, on both engines (#375). The
  `reconnectIntervalMs` doc said the delay "resets after a successful
  handshake", so with `reconnect: true` a server that completed its
  handshake and then died was relaunched about every `reconnectIntervalMs`,
  indefinitely, and never raised `mcpl-down`. A connection now counts as
  lasting only once it has lived as long as the backoff's ceiling
  (`reconnectMaxIntervalMs`, at most about 24.8 days, and never under 5
  minutes). One that ends sooner is the failure of the attempt that made it,
  numbered as that attempt's failure to connect would be, so listeners now
  meet a `reconnect-failed` that earlier releases never sent, with `error`
  "connected, then closed after N s" and its exit code, WebSocket close code
  or signal where there is one. With reconnect on, such a server backs off
  and alerts as one that never connects does.
  A host's own recycle (`reconnectAfterFailure()`) of a connection that
  hadn't lasted counts the same way, as "connected, then closed by this host
  after N s". A connection that ends on its own with a launch that can't be
  reaped still halts instead, with one permanent `reconnect-failed` in place
  of the short-end report and its line.
- With reconnect on, trace consumers now meet an
  `mcpl:server-connect-failed` for each connection that ended before it
  lasted, as above (#375). So its `attempt: 0`, which earlier releases sent
  only when the first connect failed, can now follow a first handshake that
  succeeded. A server that keeps dying that way reaches attempt 5, and from
  then on each of its failed attempts also emits an `ops:alert` trace of kind
  `mcpl-down`, which the webhook's throttle doesn't hold back. A reconnect
  still emits `mcpl:server-reconnected`, on the legacy engine only once its
  policy exchange has settled with the server still connected. So a consumer
  that posts a status line for `mcpl-down` and clears it when the server
  reconnects posts one of each per cycle in which the server lives that long,
  where before it posted neither.
- With reconnect on, both engines now print a failed attempt's line for a
  connection that ended before it lasted: "initial connect failed, will
  retry: …" for the first connection, "reconnect failed: …" for a later one
  (#375). The modern engine also prints "MCP server "<id>" reconnect
  failed: …" for each failed reconnect attempt that will be retried, as the
  legacy engine already did, so a server that stays down now prints one line
  per attempt there.
- The `mcpl-down` ops alert now reads "MCPL server down (attempt N): …" and
  "MCP server down (attempt N): …" instead of "… unreachable …", since a
  server whose connections keep ending soon after their handshake was
  reached (#375). The alert's kind and throttle are unchanged.
