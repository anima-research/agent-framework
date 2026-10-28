- `proseRouting: 'named'`, an opt-in mode where every message names its
  destination. The agent's plain text is never posted to any channel, as in
  `disabled`, nor handed with its thoughts to a module's speech handler, and
  nothing the framework sends for it falls back to a default:
  `channel_publish` needs a `channelId`, a conversation fork's included, and
  a `drafts` resend needs a destination. Every request for its turns carries
  one constant line at the system position saying so; its `channel_publish`,
  `skip_reply` and `sleep` descriptions say the same and its `think` drops
  the same-round routing sentence; its receipt says the words were kept in
  its context and sent to no one; a sleep announces nothing; and a
  closed-channel invitation offers `channel_publish` with a `channelId` that
  reaches that channel, where one does and the agent may call it. No other
  mode's routing changes, and no other agent's tools or system text do.
