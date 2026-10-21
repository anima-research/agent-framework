- The notice that a channel opened without the agent asking (an open its
  own send or reply caused, or a subscription-policy admission) names
  `channel_close` only to an agent that can call it there for every channel
  it names, except where several residents share one slot (#291), and in
  forks spawned from the primary afterwards (#235). A conversation fork can
  close only its home channel, and an agent's `allowedTools` can leave
  `channel_close` out. Before, such an agent
  was told to use `channel_close`, and couldn't call it, or its call was
  refused. Where an agent's own send opened a channel it can't close, the
  primary is now told by name too, if it can close it, and the agent is told
  that it was.
- The opened notice says "What an open channel delivers to you depends on
  its server" only to an agent whose window holds the channel's traffic.
  Before, a conversation fork was told this about a channel other than its
  home, whose messages never reach it.
- The primary's notices name a conversation fork by the channel it's bound
  to, then by its generated name. The notice of an open by an agent that has
  ended says "a message from" it, where it said "opened by X's reply" whether
  a reply or speech had opened the channel. The reply notice and speech's
  failure notice say why a channel is selected for opening again with
  "because", where they said "as".
- When a conversation fork or an ephemeral run is released without reading a
  channel notice it could act on (a channel its own send opened, or a
  channel its reply couldn't open that is selected for opening), the primary
  is told by name in its place, as for a reply whose delivery failed, of what
  still holds then: a channel closed since is left out, and so is one no
  longer selected for opening, or open since. Before, the notice stayed
  unread in the released agent's window.
