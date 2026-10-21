- When an open that speech or a reply made fails, the channel's decision goes
  back to what it was. So an agent told the open failed isn't later put
  into the channel by that open's decision. Before, the
  decision to open stayed: the agent's next speech there, or reconciliation
  when the server announced the channel again, opened it without the notice
  that says it's open and how to close it. A decision made while the open
  was out stands. Since the failed request may have reached the server, as
  when its answer is lost to a timeout, the host also closes the channel on
  the server. Where the decision put back means nobody had decided, the
  channel then follows its server's latest announcement and the
  subscription policy, which a re-announcement during the open couldn't
  apply: if they select it for opening, the host tries the open again, and
  the failure says why. Where the host can't record putting the decision
  back, the decision stays, no close is sent, and the failure says the
  channel stays selected for opening. `channel_open`'s own decision still
  outlives a failed open, as its failure says.
- A reply into a closed channel whose open fails now tells the agent that
  the reply went out and opening the channel failed, and that
  `channel_open` tries again, where the agent can call it: a conversation
  fork can't, and an agent's `allowedTools` can leave it out. The notice
  comes where the host directs the server's lifecycle
  (`channels.lifecycle`), and only when no decision about the channel, such
  as the agent closing it, was made while the open was out. A reply whose
  open only reconfirms a channel the agent already has open gets none.
  Where the channel is selected for opening after the failure, the notice
  says so and why, as speech's failure does, and that `channel_close`
  withdraws that, where the agent can call it: where the host couldn't
  record putting the channel's decision back, a later delivery or
  reconnect tries again; where the
  server's latest announcement or the policy selected it again, the host
  tries again itself. Where the channel is selected for opening and the
  replying agent has ended, the primary is told by name instead, if one is
  registered; where the replying agent can't close the channel, as a fork
  away from its home can't, the primary is told by name too, if it can.
  Before, the failure reached only the logs.
- On a server without `channels.lifecycle`, an open by speech or a reply,
  which fails there before any request is sent, no longer records a decision.
- `channel_open` on a channel that's already open, and `channel_close` on one
  that's already closed, now record the agent's decision, and so does
  `channel_decline` on a channel closed by default. So a module's
  housekeeping close is refused for a channel the agent opened itself, even
  where speech, a reply, the server or a policy had opened it first. And a
  channel the agent closed or declined isn't opened later because its server
  registers it as initially open, or a policy admits it.
- `channels/close` now has the deadline `channels/open` has when
  `requestTimeoutMs` is 0. A close the server never answers no longer holds,
  for good, the deliveries that wait for the channel's lifecycle work.
