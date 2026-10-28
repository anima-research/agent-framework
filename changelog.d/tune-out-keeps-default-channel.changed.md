- While a channel is tuned out, no message on it is the default channel or
  the message the agent is replying to, whether the tune-out diverted it or
  it came before the tune-out began. The default channel is where a turn
  with no channel of its own speaks in locus and hybrid modes, such as a
  `skip_reply` self-wake, and where `channel_publish` posts when given no
  `channelId` by a resident that isn't a conversation bound to a channel of
  its own (a subagent has no default). The message the agent is replying to
  is the one servers are told as `context.incoming` before inference, and
  the one a refusal's reaction marks. Both are now the latest message on a
  channel that isn't tuned out, which may be an older message, on another
  channel or another server, and there's none when every channel that has
  spoken is tuned out: such a resident's `channel_publish` with no
  `channelId` is then refused as having no channel to default to. Before, a
  turn with no channel of its own spoke into a tuned-out channel during its
  tune-out whenever the last message to set the default had been posted
  there.
- Once a tune-out ends, its channel's messages count again, the ones it
  diverted included.
- A channel that was the default when it went, its server removed or the
  channel withdrawn, is kept, gone, until the next message comes, and is the
  default while no newer message counts, so a newer message on a channel
  that's tuned out doesn't move the default past it (a server's removal
  drops its message and thread, and a withdrawal keeps them, as before), and
  a call that would default to it is refused as the default gone, as before.
  Any other channel that goes is dropped then, a tuned-out one included, so
  it doesn't become the default when its tune-out ends.
- When a tune-out ends, the agent's wake for it now names the channel the
  tune-out ended, so a turn that wake starts puts its plain speech there.
  Merged with other wakes, it fares as an unaddressed channel message's wake
  does; taken into a turn already open, its dump leaves that turn's locus
  where it is, while the subconscious's note on that channel, when there is
  one, can move it, as an unaddressed message there can. When the channel is
  gone from the registry, as after its server is removed, the wake names no
  channel. Before, that wake named no channel, and its turn took the default
  channel, which was the tuned-out channel only when the last message to set
  it had been posted there.
- `channel_publish`'s description now says that its default is the latest
  message on a channel that isn't tuned out, and that a notice such as a
  join doesn't set it, as was already the case.
