- In a tuned-out channel, a held reaction, edit or deletion that
  addresses the agent no longer gets a `channels/acknowledge` request
  (#476). Neither does a `chat:system` notice. Before, the request named
  the line's own id. A change line's id, such as zulip_mcp's
  `edit:77:…`, names no platform message. A held message that addresses
  the agent still gets its request, as before. So does an edit that the
  host delivers as the first version of its message that the agent
  sees. On the push lane, the request still names the event's id, as
  before. The reader's wake is unchanged.
