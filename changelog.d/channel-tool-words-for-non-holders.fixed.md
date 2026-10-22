- `channel_open` and `channel_close` promise delivery only to an agent whose
  window holds the channel's traffic. An ephemeral run, and on a host that
  routes conversations every agent but a conversation fork, are now told that
  opening or closing a channel does so for every agent on the host, that
  opening it brings them none of its messages and closing it stops none
  reaching them, and that `channel_open`'s history comes back in its result.
  Before, they were told "Messages that address you still reach you" and
  offered history "preceding the message that invited you", though a channel's
  messages go to the residents, or to its fork or nowhere. Residents of a host
  that doesn't route conversations, and conversation forks, keep the words they
  had, so their cached tool lists don't change; a fork keeps them through its
  closure turn after its binding expires. On a host with no residents, the run channel messages are stored
  with is a holder, so when it ends, the next run's words change to the
  holder's.
