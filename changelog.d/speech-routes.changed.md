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
  turn's route. Only the next true new turn decides again.
- **Mid-turn ambiguity hold replaces the addressed re-pin.** When a presented
  mid-turn arrival from another conversation addresses the resident, or
  continues a conversation the resident explicitly sent into this turn, an
  inferred route is held for the rest of the turn instead of moving to the
  newcomer. A notice rides the same injection batch. Ambient chatter,
  reactions and arrivals in the same conversation change nothing, and the
  reply edge stays on the message that woke the turn. Deliberate routes are
  never held: a fork's home, a `channel_open`, and a hybrid `>>>` target.
- **`channel_open` sets the speech route** for the rest of the turn by
  default, replacing an inferred route, a hold, or a hybrid `>>>` target. The
  new `setSpeechTarget: false` opens the channel for reading only, and the
  result says where speech goes then.
- **`channel_publish` is an explicit send through the publish executor.**
  Without `channelId` it goes to the caller's current route. With no route
  (held, a local surface, or none) it is refused with the reason, and it no
  longer uses the most recent inbound channel. A new optional `serverId`
  disambiguates a channel id that several servers register. Its receipt
  names `serverId`, `channelId` and `channelLabel`. A failed or unknown
  outcome is an error that keeps its `status` and the attempted destination;
  `unknown` warns that the message may already have been posted.
- The beforeInference channel context (`defaultOutgoing` and `incoming`),
  refusal reactions, rewind notices and the failure log now use the agent's
  own route and its reply edge, so what the agent is told matches where its
  words go.
- A batched gate wake reports every conversation in its batch to the
  framework (`WakeProvenance.routeCandidates`). An addressed event whose
  registered channel the host can't resolve still competes, so the turn is
  held, but it is never itself a route.
