- In a tuned-out channel, a held line's `channels/acknowledge` request
  now names a platform message, or it isn't sent (#476). A held reaction,
  deletion or `chat:system` notice that addresses the agent gets none.
  Before, the request named the line's own id, or on the push lane the
  event's id, and neither names a message: zulip_mcp's `edit:77:…` and
  `zulip_msg_77`, or discord-mcpl's `discord_msg_<id>`. On the push lane
  the request now names `origin.messageId`, and none is sent where the
  push has none. On the channel lane none is sent for a message that
  the host delivers by its event's id. A held message that addresses the
  agent still gets its request. So does an edit that addresses the agent
  when its id names its message: on the channel lane, an edit that
  carries an `eventId` (MCPL SPEC §20.3.1), and on either lane, an edit
  that the host delivers as the first version of its message that the
  agent sees. Another edit gets none, such as zulip_mcp's change line.
  The reader's wake is unchanged, and #476 stays open for it.
