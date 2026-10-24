- Each MCPL server is told only of its own channels in
  `context/beforeInference`'s channel context (SPEC §14.4): `incoming` and
  `defaultOutgoing` only when that channel is the server's, and `candidates`
  only its own open channels. Every capable server was told the same
  context, other servers' channels included, by their ids alone, which a
  server registering the same id would read as its own. A server that read
  other servers' channels from it no longer hears of them.
- A `[prose-routing]` bounce that lists the channels its target could mean
  gives its resend examples with the first of them written as one token,
  such as `>>a:general {{unsent}}` and `destination: "a:general"`, where it
  gave `>>#channel` and `"#channel"` whatever it listed.
- The `mcpl:conversation-spawned`, `-spawn-failed`, `-unrouted`,
  `-binding-orphaned`, `-closed` and `-disposed` traces carry the channel's
  `serverId`, and a refusal's failure log names its locus as the agent is
  shown it.
- `inference:started` carries the server of its `channelId` as `serverId`,
  so a host that posts back to the turn's channel can name it where two
  servers register the id. `inference:tokens` and `inference:content_block`
  carry the id alone.
- `channel_list` gives a channel whose id names another channel too, another
  server's channel with that id or another channel's server-qualified id, a
  `name`: its server-qualified id, where that names it alone, which
  `channelId` takes, and a `>>` target too where it is one token. Other rows
  are as they were.
- The results of `channel_open`, `channel_close` and `channel_decline` carry
  the channel's `serverId` in their `data`.
- An open that a tune-out overtook ends as `channel_open`'s refusal of a
  tuned-out channel does, saying how the tune-out ends: by cancelling it,
  which delivers the diverted backlog, or, for a channel no name picks
  alone, by itself.
- A fork's channel refusals quote its channel and what the call asked for.
- A `serverId` given to `channel_publish`, whose schema has none, is read
  beside a `channelId` as that exact pair, and with no `channelId` as the
  default channel's id on that server, where it was ignored.
- A drafts resend whose destination names a channel that takes no posts is
  refused before anything is sent, as a `>>` target naming one is; before,
  the send refused its first draft.
- In explicit mode, a start whose wake names no channel, such as a budget
  restart or a re-inference, keeps typing in the channel the turn shows,
  starting it again where a stop or a failed start ended it, and its token
  traces carry that channel's id, where they carried none.
