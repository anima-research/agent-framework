- A debounced gate batch's wake starts no turn for an agent that has already
  read and answered every event in it (#814). Each event is judged as a direct
  wake's message is: its message covered by a request the agent answered and,
  for one a reply is owed for (a registered channel's, not marked
  `chat:ambient` or `chat:system`), the agent's publication there since it
  read it; or its message gone. Under `proseRouting: 'explicit'`, a
  publication still on its way when a tool ends the turn isn't counted yet, so
  that event's wake starts a turn: explicit mode doesn't hold a turn for its
  deliveries. A message stored and not yet presented to the agent keeps the
  wake. An event counts only for the agent its message was placed for: every
  other agent the batch wakes still wakes for it, the other residents whose
  windows hold it and, for a message routed to a conversation fork, the trunk
  and every other fork, since a batch wakes every gate recipient (#243). The
  scheduler judges it when the agent's turn would start. A request that fails
  or is aborted answers nothing, though a round of the turn that came back
  before it has answered what that round read. This covers MCPL channel
  messages, those routed to a conversation fork included, and pushes,
  message-mode heartbeat ticks and reminders, and module events whose response
  stored exactly one message, for every agent, where neither the event nor the
  message names a channel and the event isn't console or API input. A module
  message stored only for the agents its response asked inference for, or one
  held from the residents, is quoted, as before. An event with no message of
  its own keeps the wake,
  unless a turn already under way read and answered the batch's line, which
  quotes it. A silent heartbeat tick stores nothing and isn't quoted. A judge
  rule's batch is judged so too where no judge decided
  it (none wired, or one that failed, timed out or made no call, with
  `onError: "wake"`), and on a reply verdict, except for an event the gate's
  `isAnswered` counts as answered when the judge answers. AgentFramework's
  counts one a request the agent had answered carried, whether or not it had
  published there, and one whose writer or message is gone, or where it can't
  tell. Such an event keeps the wake, so the judge's reply stands. A deferred
  render's batched wake is unchanged.
