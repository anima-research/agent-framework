- In a tuned-out channel, a held line's `channels/acknowledge` request
  now names the id that the server gave as the message's, and the host
  sends none where it has no such id (#476). A held reaction, deletion
  or `chat:system` notice gets none. On the push lane the request names
  `origin.messageId`, where before it named the event's id, and a push
  without one gets none. On the channel lane, the host sometimes knows a
  message only by its event's id, and such a message gets none. An edit
  gets a request only when its id is its message's id. On the channel
  lane that holds for an edit that carries an `eventId` (MCPL SPEC
  §20.3.1). On either lane it holds for an edit that the host delivers
  as the agent's first view of its message. Other edits get none, such
  as zulip_mcp's `edit:77:…` lines. A held message still gets its
  request. The reader's wake is unchanged, and #476 stays open for it.
