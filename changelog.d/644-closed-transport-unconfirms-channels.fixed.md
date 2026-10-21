- When an MCPL server's connection closes, its channels no longer read as
  open, or as confirmed closed, on the connection that follows (#644). The
  closed transport's confirmations held for that transport only, but they
  stayed: between a reconnect and the server's next registration,
  `channel_open` answered "already open" and asked the server nothing, and
  `channel_close` answered "already closed". Now each channel reads as a
  freshly registered one does until it's confirmed again: it's left out of
  the open-channel list, and an addressed message there arrives as the
  invitation a closed channel's does. While the server is down,
  `channel_open` and `channel_close` say so and record the decision. Once
  it's back, where this host opens and closes the server's channels (its
  `channels.lifecycle` grant), they ask the server, and delivery opens the
  channel before it publishes. Where it doesn't, the channel reads as open
  again once its traffic shows it, and delivery is refused until then, as
  after a registration. Messages and lifecycle answers that were under way
  when the connection closed no longer confirm a channel after it; messages
  the connection held across the reconnect are admitted with the next
  connection, as before.
- A conversation fork now leaves out every other registered channel's
  context injections, open or not. Before, it left out only another open
  channel's, so a channel the agent had closed, or one not yet confirmed,
  had its injections shown to every fork as general context.
