- **Speech routes: unaddressed plain speech goes where the turn was
  deliberately or actually addressed, and to the last channel that saw
  traffic only when nothing in its wake named a conversation.** A turn's
  route is decided once at a true new turn:
  - a conversation fork's home channel always wins;
  - otherwise it is inferred from the whole wake. The addressed messages count
    if there are any, else all of the conversational ones. A local surface
    such as the console, the TUI or the API counts as addressed. The route is
    inferred only when they name one conversation (server, channel and
    thread), and its newest triggering message is the reply edge.

  Several competing conversations start the turn **held**: unaddressed speech
  is kept as `ambiguous` drafts, and a `[routing]` notice names each
  conversation's address.

  **A resident's wake that names no conversation at all keeps the
  fallback,** as before: a heartbeat, a timer, a self-wake, a background
  script's wake, an admin nudge, or an `api:inference-request` nudge.
  - **Where it goes:** where the last message any channel delivered came in,
    now with its server and thread named. An ordinary message counts once
    it's queued, and a coalesced one once its coalescer admits it afresh,
    never for a producer's retry the coalescer acknowledges again. A
    reaction, a deletion or a withdrawal is no message, so it never becomes
    that place.
  - **What it answers:** no message. It has no reply edge, so the
    `beforeInference` context names where the speech lands
    (`defaultOutgoing`) but no `incoming` message.
  - **How it's checked:** like every route. A channel that declares no
    publish target, a thread on a `root` channel, or a channel a
    conversation fork owns gives no route, and the speech is held as
    `no-destination` drafts.
  - **What the resident is told:** a `[routing]` notice says the speech goes
    where the last message came in because nothing in the wake named a
    conversation. A mid-turn arrival that addresses the resident from
    elsewhere holds a fallback route as it holds an inferred one, and the
    notice says what the route was.
  - **Which wakes name a conversation:** any event in the wake that names a
    channel, a thread, an author or a local surface does, whether or not
    it's a route candidate, on every lane. So does a conversation's closure
    and a tune-out wake about a channel. A reaction, a system marker or a
    channel another agent's fork owns names one but answers nothing, so such
    a wake gets no route, never the fallback. An ambient-only batch names
    its own conversations: it routes to one, or holds when it names several.
  - **A framework wake that continues a turn names that turn's
    conversations:** the retry after a rewind (for a refusal, an unstick's
    forced rewind, or an inference failure); an unstick itself; the results
    of a non-streaming tool round; an explicit-prose continuation or bounce;
    and a provider-cooldown retry that holds no wake of its own. The wake
    carries those conversations, read when it is queued, as addressed ones,
    so its words go where the turn's would have. Beside a heartbeat they keep
    the turn, beside an ambient arrival from elsewhere they win, and beside
    an addressed one from elsewhere the turn is held. The route is inferred
    from them like any wake's: a `channel_open` sets a route for its own
    turn only. A bounce during a turn queues its wake when that turn ends, so
    it names where the turn's words went by then, after a `channel_open` or
    a hold. A fallback turn named no conversation, so its continuation names
    none and takes the fallback afresh. A turn whose words had no place (a
    silent tick, or a wake whose conversation it couldn't take) gives its
    continuation no place either, never the fallback, and a silent tick's
    continuation queued during it is a silent tick too. The new turn is
    otherwise fresh, as any is: a rewind sheds the turn whose choices those
    were.
  - **An ephemeral subagent never takes the fallback.** Its prose isn't a
    channel's, and before speech routes a subagent's prose between its tool
    calls could reach the resident's live channel this way.

  A surface route shows speech on that surface and publishes it to no
  channel, so a console turn's reply stays on the console. That's so
  whether its module added the input as a message or only requested
  inference. anima-research/agent-framework#190, by @rufalupa666-netizen
  with the resident qa-engineer, found and diagnosed such a reply published
  to the channel that last spoke.
- Context-budget restarts, guard retries and a stream's own retries (its
  later attempts) keep the turn's route, and everything else the turn has
  chosen or done: its explicit-send engagement, its `>>` or `>>>` choice, and
  the deliveries and drafts its receipt reports. Only the next true new turn
  decides again, and a queued wake that continues a turn starts one.
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
  Without `channelId` it goes to the caller's current route, the fallback
  included. With no route (held, a local surface, or none) it is refused
  with the reason, rather than going to the most recent inbound channel. A new optional `serverId`
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
  registered channel the host can't resolve still competes with the other
  addressed conversations: beside one, the turn is held; alone, the turn
  has no route, since it is never itself a route. A coalesced item is gated with the
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
  wakes already worked this way. A route is judged when the turn starts, as
  ownership stands then, so a fork's claim, or its giving a channel up,
  while a wake waits in the queue counts.
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
- **More of routing keeps the server and the thread.** A `>>` or `>>>` pin
  keeps the server its target resolved to, so the same id registered by a
  second server later changes nothing. Typing shows on the route's own
  server's channel, and an id two servers share, named alone, shows no
  indicator rather than one on a guessed server. `inference:started` and
  the failure log name the route's server beside its channel. The gate's
  batched-wake notice counts a thread apart from its channel's root, and
  the beforeInference context's `defaultOutgoing` carries the route's place
  as its publish does: the thread, or `null` for the root (MCPL RFC-011
  revision 5's amendment of §14.4). The `mcpl:speech-routed`,
  `mcpl:speech-route-failed` and `prose:draft-resent` traces carry
  `threadId` (null for the root).
- **A thread id is read one way** by `channel_publish`, `channel_open` and
  `drafts` resend: surrounding whitespace is trimmed, and a blank or
  non-string id is refused with nothing sent, opened or set.
- **Unaddressed speech that provably wasn't posted is kept.** A publish
  that fails with nothing posted keeps its words as a bounce draft, on the
  route, a sticky `>>>` pin or the sleep announcement, and the one
  `[discord-send-failed]` notice names the draft and how to resend it. An
  unconfirmed publish keeps none, so as not to invite a duplicate.
- **The sleep announcement is unaddressed speech.** It follows a hybrid
  `>>>` pin, else the turn's route, after the words written before it. A
  held or routeless turn keeps it as a draft, and a surface shows it.
- **A mid-turn hold names every arrival that suspends the route** in that
  round, each with its own cause. A local surface's message reads as
  addressing the resident, tagged or not.
- **In a silent wake, `channel_open` opens the channel and sets no route.**
  Its result says the wake's plain speech stays private and that a send
  tool posts there.
- **Only the host marks machinery.** `system: true` in a push's origin or
  an incoming message's metadata is dropped at ingestion and never makes
  the item non-conversational, so it is still a route candidate.
- **A route candidate isn't lost or invented on the way to a wake.** An
  unroutable candidate in a fork's channel follows the fork rule, so it
  holds no other agent's turn. A module event that names a channel is that
  channel's conversation, unroutable, never a local surface's. An event the
  gate's inference buffer evicts keeps its route candidate, so an
  addressed conversation still competes. A coalesced item is gated (and so
  becomes a candidate) only once its coalescer admits it for delivery,
  never for a retry, a retraction or a refused occurrence.
- **An ordinary push or incoming message is accepted** (the acceptance
  observer is told) only once its trigger filter returns, right before it
  is queued; a filter that throws leaves nothing accepted.
- `publishForAgent` traces `mcpl:speech-routed` only for a confirmed
  delivery, once the outcome is in, and a failed or unconfirmed one as
  `mcpl:speech-route-failed`. `publish()` rechecks the server and its
  `channels.publish` grant after opening a closed channel, as well as
  before. A label shows as its connector gave it: no `#` is added.
