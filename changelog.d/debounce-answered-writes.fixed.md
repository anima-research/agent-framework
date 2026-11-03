- A debounced gate batch's wake starts no turn for an agent that has already
  read and answered every event in it (#814). Each event is judged as a direct
  wake's message is: its message at or under a request the agent answered
  and, for one a reply is owed for (a registered channel's, not marked
  `chat:ambient` or `chat:system`), the agent's publication there since it
  read it; or its message gone. An event counts only for the agent it was
  written for, so residents who share that agent's window still wake for it.
  The scheduler judges it when the agent's turn would start. Under
  `proseRouting` `locus`, the default, and `hybrid`, that is after the
  agent's last turn and that turn's final publication have ended. Under
  `explicit`, a turn a tool ends, such as `skip_reply`, doesn't wait for its
  deliveries, so a batch whose only answer is still being published wakes
  the agent, as before. A request that fails or is aborted answers nothing,
  though a round of the turn that came back before it has answered what that
  round read; an event the host gave no message of its own keeps the wake.
  This covers MCPL channel messages and pushes, those routed to a
  conversation fork included, heartbeat ticks and reminders, and module
  events whose response adds exactly one message, where neither the event
  nor the message names a channel and the event isn't an `external-message`
  or `api:message`; any other module response keeps the wake. A judge rule's
  batch is judged so too where no judge decided it (none wired, or one that
  failed, timed out or made no call, with `onError: "wake"`), and on a reply
  verdict, except for an event the agent had already answered when the judge
  answered: the judge answered after it, so its reply stands. A deferred
  render's batched wake is unchanged.
