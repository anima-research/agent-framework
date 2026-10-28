- **Residents and hosts whose agents answer a heartbeat in plain speech:** a
  turn the heartbeat opens (a tick or a reminder, from the framework's
  heartbeat or from an MCPL server whose id is `heartbeat`; a silent tick
  already keeps its words private) no longer posts its plain speech where the
  latest inbound message came from. That turn has no channel and takes no
  fallback, in every routing mode. Its plain speech with no destination of
  its own is held as a draft the agent can resend with `drafts` (in explicit
  mode it's a bounce, so `{{unsent}}` names it too), and named in the turn's
  `[delivered]` receipt, or in a notice mid-turn; in locus and hybrid mode
  the turn is told so in a `[routing]` notice before it compiles, once per
  heartbeat. The bounce of
  such words with no destination is noticed but requests no wake, and
  doesn't count toward the bounce-wake cap; a `>>` or `>>>` target that
  fails still wakes the agent, and an autoContinue agent's run from a
  heartbeat continues as configured, each continuation holding its words too.
  What still reaches a channel: an explicit send, a `>>` or `>>>`
  destination, the agent's own `channel_open`, and a re-pin when an
  addressed message arrives mid-turn. Other wakes that carry no channel
  (timers, a host's own requests) route as before, and so does a heartbeat
  a gate rule batches (a `debounce` or `judge` rule matching it), which wakes
  as the gate's batch. The turn doesn't announce a locus change, so the next
  channel turn doesn't re-announce its channel.
  **Migration:** an agent that checked in by speaking from its heartbeat now
  needs an explicit send to reach someone; say so in the heartbeat's message
  (`heartbeat_configure`'s `message`), for example "your plain words stay
  with you as drafts; send to reach someone".
