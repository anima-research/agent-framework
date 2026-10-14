- `McplServerConnection`'s `'close'` event now carries a third argument,
  `McplConnectionCloseInfo` (`transport`, `code`, `signal`, `reason`,
  `byHost`), so a host can see the WebSocket close code a networked MCPL
  server sent (e.g. 4001 for an expired or refused credential) and refresh
  what `accessProvider` hands the next dial instead of replaying it. The
  first two `(code, signal)` arguments are unchanged; host-initiated closes
  now pass `(null, null, info)` where they passed nothing. The type is
  exported from the package root alongside `McplServerConnection`.
