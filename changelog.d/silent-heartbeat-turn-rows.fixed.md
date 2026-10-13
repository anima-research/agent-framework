- Silent heartbeat ticks no longer merge into the previous assistant message
  on the wire. The rows a tick's reply stores (assistant responses,
  tool_result rows) now carry
  `metadata.silentHeartbeat: { eventId, serverId, agentName, separator }`,
  and request builds render a request-only separator user turn, carrying
  the tick's instruction, immediately before the first of the tick's rows
  that survives compilation (the agent's own opening request for a tick
  ends on that same turn instead of `[Continue]`). The separator's text is
  the one the tick's request rendered, recorded in the stamp; rows stamped
  without it render the bare `[heartbeat tick]` their requests carried.
  Nothing new is stored, and the separator's position follows from the
  stamped rows alone, so it is identical on every compile and keeps the
  cached prefix stable. A tick is told apart by its server and event id
  together. Rows are recognised by tool_use ids and signed or redacted
  thinking only: an unsigned, tool-free tick reply still merges as before
  (no signed thinking, so no provider rejection). Previously back-to-back
  ticks, or a tick after a reply that left no delivery receipt, were sent as
  one assistant message carrying signed thinking from two responses.
