- A debounced gate batch's wake starts no turn for an agent that has already
  read and answered every event in it (#814). Each event is judged as a direct
  wake's message is: its message at or under a request the agent answered
  and, for one a reply is owed for (a registered channel's, not marked
  `chat:ambient` or `chat:system`), the agent's publication there since it
  read it; or its message gone. An event counts only for the agent it was
  written for. Every other agent the batch wakes still wakes for it:
  residents who share that agent's window and, for a message routed to a
  conversation fork, the trunk and every other fork, since a batch wakes
  every gate recipient (#243). The scheduler judges it when the agent's turn
  would start. Under every `proseRouting` mode but `explicit`, that is after
  the agent's last turn and that turn's final publication have ended. Under
  `explicit`, a turn a tool ends, such as `skip_reply`, doesn't wait for its
  deliveries, so a batch whose only answer is still being published wakes
  the agent, as before. A request that fails or is aborted answers nothing,
  though a round of the turn that came back before it has answered what that
  round read; an event the host gave no message of its own keeps the wake.
  Batches held for an agent's turn or the host's quiesce are delivered in
  two parts, those whose every event has a write and the rest, so an event
  without a write keeps only its own part's wake, and that part's line names
  that part's events alone.
  This covers MCPL channel messages and pushes, those routed to a
  conversation fork included, heartbeat ticks and reminders, and module
  events whose response adds exactly one message, where neither the event's
  metadata nor the message's names a channel and the event isn't an
  `external-message` or `api:message`; any other module response keeps the
  wake. A judge rule's batch is judged so too where no judge decided it (none
  wired, or one that failed, timed out or made no call, with
  `onError: "wake"`), and on a reply
  verdict, except for an event the gate's `isAnswered` counts as answered
  when the judge answers. AgentFramework's counts one in a request the agent
  had already answered, whether or not it had published there, and one whose
  writer or message is gone, or where it can't tell. Such an event keeps the
  wake, so the judge's reply stands, and its batch keeps the base's rule:
  its line is written when it's delivered, naming every event, or, for one
  message still the newest entry then, handed to the delivery agent's start.
  A deferred render's batched wake is unchanged.
