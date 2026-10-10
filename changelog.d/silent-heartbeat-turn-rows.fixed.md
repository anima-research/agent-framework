- Silent heartbeat ticks no longer merge into the previous assistant message
  on the wire. Every row a tick's turn stores (assistant responses,
  tool_result rows) now carries
  `metadata.silentHeartbeat: { eventId, serverId, agentName }`, and request
  builds render a request-only `[heartbeat tick]` user turn immediately
  before the first of the tick's rows that survives compilation (the agent's
  own opening request for a tick ends on that same turn instead of
  `[Continue]`). Nothing new is stored, and the separator's position follows
  from the stamped rows alone, so it is identical on every compile and keeps
  the cached prefix stable. Rows are recognised by tool_use ids and thinking
  signatures only: an unsigned, tool-free tick reply still merges as before
  (no signed thinking, so no provider rejection). Previously back-to-back
  ticks, or a tick after a reply that left no delivery receipt, were sent as
  one assistant message carrying signed thinking from two responses.
