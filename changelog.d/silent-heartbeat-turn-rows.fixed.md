- Silent heartbeat ticks no longer merge into the previous assistant message
  on the wire. Every row a tick's turn stores (assistant responses,
  tool_result rows) now carries `metadata.silentHeartbeat: { eventId, serverId }`,
  and request builds render a request-only `[heartbeat tick]` user turn
  immediately before each tick's first stored row (the tick's own request
  ends on that same turn instead of `[Continue]`). Nothing new is stored: the
  separator's position follows from the stamped rows alone, so it is
  identical on every compile and keeps the cached prefix stable. Previously
  back-to-back ticks, or a tick after a reply that left no delivery receipt,
  were sent as one assistant message carrying signed thinking from two
  responses.
