- A message deferred during a turn that can't join the live stream at a tool
  boundary — one carrying tool blocks, or named as the agent itself — now
  waits for the turn's end, after its last round, instead of being stored at
  the boundary between rounds the stream never showed it. Messages queued
  behind it wait with it, so the queue keeps its order; messages queued
  before it are still heard at the boundary. Stored between rounds, it sat
  before the turn's later replies in every later compile although their
  requests never held it: a prompt-cache divergence, and on a provider that
  binds signed thinking to the prefix it was minted under (context-manager
  #155), a reply whose thinking is refused.
- A message injected into the live stream at a tool boundary now counts as
  read for RFC-006 coalescing: the consumed watermark moves when messages
  are injected, not only at a compile. Before, an injected message sat above
  the watermark of the turn's compile, so a coalesced replacement for its
  subject could remove a message the agent had heard and answered.
- A deferred write that goes back into the queue because a turn is alive now
  does so whatever its content. A `tool_result` used to land regardless,
  apart from the `tool_use` it answers, which went back into the queue.
