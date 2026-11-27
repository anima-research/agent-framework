- In a tuned-out channel, the host no longer sends a
  `channels/acknowledge` request that names no platform message (#476).
  A held reaction, deletion or `chat:system` notice gets none. On the
  push lane the request names `origin.messageId`, where before it named
  the event's id, and a push without one gets none. On the channel lane,
  the host sometimes knows a message only by its event's id, and such a
  message gets none. An edit gets a request only when its id is its
  message's id. That holds for an
  edit that carries an `eventId` (MCPL SPEC §20.3.1). It also holds for
  an edit that the host delivers as the agent's first view of its
  message. Other edits get none, such as zulip_mcp's `edit:77:…` lines.
  A held message still gets its request. The reader's wake is unchanged,
  and #476 stays open for it.
