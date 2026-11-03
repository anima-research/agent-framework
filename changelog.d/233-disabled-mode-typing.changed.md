- A `proseRouting: "disabled"` turn shows a typing indicator in the channel of
  the message that woke it, by the rule an explicit mode turn already follows,
  where before it showed none. A turn woken by a gate batch of ambient messages
  alone, a heartbeat's turn and a silent wake's show none, as in explicit mode.
  Typing is all it gains: its `inference:tokens` and `inference:content_block`
  traces still carry no `channelId`, since its text is never sent to a channel.
