- **Speech routes: unaddressed plain speech goes where the turn was
  deliberately or actually addressed, never to the last channel that saw
  traffic.** A turn's route is decided once at a true new turn:
  - a conversation fork's home channel always wins;
  - otherwise it is inferred from the whole wake. The addressed messages count
    if there are any, else all of the conversational ones. A local surface
    such as the console, the TUI or the API counts as addressed. The route is
    inferred only when they name one conversation (server, channel and
    thread), and its newest triggering message is the reply edge.

  Several competing conversations start the turn **held**: unaddressed speech
  is kept as `ambiguous` drafts, and a `[routing]` notice names each
  conversation's address. A turn with no conversation, such as a heartbeat,
  a timer or a self-wake, has no route, and its speech is held as
  `no-destination` drafts. Previously such speech went to the process-global
  most-recent-inbound channel. That is also the fallback the batched-wake
  routing fix kept for ambient-only batches, and this change replaces it. A surface
  route shows speech on that surface and publishes it to no channel.
- Context-budget restarts, guard retries and framework retries keep the
  turn's route, and everything else the turn has chosen or done: its
  explicit-send engagement, its `>>` or `>>>` choice, and the deliveries and
  drafts its receipt reports. Only the next true new turn decides again.
- **Speech goes where the route stood when its words were written.** A
  `channel_open`, or a hold, that lands while earlier words still wait to be
  published governs only words written after it; the same goes for a
  `channel_open` superseding a hybrid `>>>` choice. A text-only or trailing
  reply is published along its own turn's route, even once the agent is idle
  and a next turn may have begun.
- **Mid-turn ambiguity hold replaces the addressed re-pin.** When a presented
  mid-turn arrival from another conversation addresses the resident, or
  continues a conversation the resident explicitly sent into this turn, an
  inferred route is held for the rest of the turn instead of moving to the
  newcomer. A notice rides the same injection batch. A send whose place the
  host knows (a resend or `channel_publish`, delivered or unconfirmed)
  engages exactly that conversation, thread included; a connector's own send
  tool chooses its place itself, so it engages its whole channel, and the
  notice says where in the channel isn't known. Ambient chatter in a
  conversation the resident hasn't sent into this turn, reactions, and
  arrivals in the same conversation change nothing, and the reply edge stays
  on the message that woke the turn. Deliberate routes are
  never held: a fork's home, a `channel_open`, and a hybrid `>>>` target.
- **`channel_open` sets the speech route** for the rest of the turn by
  default, replacing an inferred route, a hold, a hybrid `>>>` target, or the
  suppression a `>>>skip_reply` or a failed envelope left. The
  new `setSpeechTarget: false` opens the channel for reading only, and the
  result says where speech goes then.
- **`channel_publish` is an explicit send through the publish executor.**
  Without `channelId` it goes to the caller's current route. With no route
  (held, a local surface, or none) it is refused with the reason, and it no
  longer uses the most recent inbound channel. A new optional `serverId`
  disambiguates a channel id that several servers register; a conversation
  fork may name a server only as its home's sole registrant, since the same
  id on another server is another conversation. Its receipt
  names `serverId`, `channelId` and `channelLabel`. A failed or unknown
  outcome is an error that keeps its `status` and the attempted destination;
  `unknown` warns that the message may already have been posted.
- The beforeInference channel context (`defaultOutgoing` and `incoming`),
  refusal reactions, rewind notices and the failure log now use the agent's
  own route and its reply edge, so what the agent is told matches where its
  words go. A fork's reply edge is the wake's newest addressed message in
  its home conversation, or else its newest message there.
- A batched gate wake reports every conversation in its batch to the
  framework (`WakeProvenance.routeCandidates`). An addressed event whose
  registered channel the host can't resolve still competes, so the turn is
  held, but it is never itself a route. A coalesced item is gated with the
  host's source envelope too, the one its coalescer then freezes, and an
  `inboundSource` key in a connector's origin or metadata is never read as
  one.
- **A channel id no single server registers is never given a server by
  guess.** A fork's home, or a wake candidate whose event named no server,
  takes the server only from the id's sole registrant. On an id that several
  servers share, the turn records the conversation as `unresolved`, and its
  speech is held as drafts rather than published to whichever server
  registered first. `unresolved` also now covers a route whose channel was
  withdrawn, which used to read as undeclared (`untargetable`).
- **A fork's channel is its own on every wake path.** A push event, a
  coalesced push and a `channels/incoming` broadcast now give no other agent
  a speech route or a typing indicator in a channel a conversation fork owns,
  and a fork takes neither in a channel other than its home. Batched gate
  wakes already worked this way.
- The `[discord-send-failed]` marker for a reply on a thread route names the
  thread with its channel, and an unconfirmed one says to check the thread.
- **Routing names each conversation with its server.** Routing notices,
  holds, the route announcement, `channel_publish`'s refusals and failures,
  the `[discord-send-failed]` marker, the `[channels] Now open` notice, the
  gate's batched-wake lines and the `[delivered]` receipt all write a
  conversation one way: its label, then `server / channel-id`, then its
  thread. The label is that server's own for the channel, never another
  server's for the same id, and a batched wake counts each server's channel
  apart. Two servers' channels with the same id and label no longer read
  alike. A refusal for a channel id that several servers register lists
  those servers, so the sender has a `serverId` to give.
